'use strict';

const assert = require('chai').assert;
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

const TEST_TIM_YAML = `
metadata:
  name: {{build_id}}
  container: {{container}}
  launchVersion: {{launcher_version}}
  serviceAccount: {{service_account}}
command:
- "/opt/screwdriver/launch {{api_uri}} {{store_uri}} {{token}} {{build_id}}"
`;

describe('index', () => {
    let Executor;
    let requestMock;
    let fsMock;
    let executor;
    const testBuildId = '80754af91bfb6d1073585b046fe0a474ce868509';
    const testToken = 'abcdefg';
    const testApiUri = 'http://api:8080';
    const testStoreUri = 'http://store:8080';
    const testContainer = 'node:4';
    const testLaunchVersion = 'stable';
    const testServiceAccount = 'default';
    const jobsUrl = 'https://kubernetes.default/apis/batch/v1/namespaces/default/jobs';

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub();

        fsMock = {
            readFileSync: sinon.stub()
        };

        fsMock.readFileSync.withArgs('/var/run/secrets/kubernetes.io/serviceaccount/token')
            .returns('api_key');
        fsMock.readFileSync.withArgs(sinon.match(/config\/job.yaml.tim/))
            .returns(TEST_TIM_YAML);

        mockery.registerMock('fs', fsMock);
        mockery.registerMock('request', requestMock);

        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor({
            ecosystem: {
                api: testApiUri,
                store: testStoreUri
            },
            fusebox: { retry: { minTimeout: 1 } }
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    it('supports specifying a specific version', () => {
        assert.equal(executor.launchVersion, 'stable');
        assert.equal(executor.serviceAccount, 'default');
        assert.equal(executor.token, 'api_key');
        assert.equal(executor.host, 'kubernetes.default');
        executor = new Executor({
            kubernetes: {
                token: 'api_key2',
                host: 'kubernetes2',
                serviceAccount: 'foobar',
                jobsNamespace: 'baz'
            },
            launchVersion: 'v1.2.3'
        });
        assert.equal(executor.token, 'api_key2');
        assert.equal(executor.host, 'kubernetes2');
        assert.equal(executor.launchVersion, 'v1.2.3');
        assert.equal(executor.serviceAccount, 'foobar');
        assert.equal(executor.jobsNamespace, 'baz');
    });

    it('extends base class', () => {
        assert.isFunction(executor.stop);
        assert.isFunction(executor.start);
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(executor.stats(), {
                requests: {
                    total: 0,
                    timeouts: 0,
                    success: 0,
                    failure: 0,
                    concurrent: 0,
                    averageTime: 0
                },
                breaker: {
                    isClosed: true
                }
            });
        });
    });

    describe('stop', () => {
        const fakeStopResponse = {
            statusCode: 200,
            body: {
                success: 'true'
            }
        };
        const deleteConfig = {
            uri: jobsUrl,
            method: 'DELETE',
            qs: {
                labelSelector: `sdbuild=${testBuildId}`
            },
            headers: {
                Authorization: 'Bearer api_key'
            },
            strictSSL: false
        };

        beforeEach(() => {
            requestMock.yieldsAsync(null, fakeStopResponse, fakeStopResponse.body);
        });

        it('calls breaker with correct config', () => (
            executor.stop({
                buildId: testBuildId
            }).then(() => {
                assert.calledWith(requestMock, deleteConfig);
                assert.calledOnce(requestMock);
            })
        ));

        it('returns error when breaker does', () => {
            const error = new Error('error');

            requestMock.yieldsAsync(error);

            return executor.stop({
                buildId: testBuildId
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.deepEqual(err, error);
                assert.equal(requestMock.callCount, 5);
            });
        });

        it('returns error when response is non 200', () => {
            const fakeStopErrorResponse = {
                statusCode: 500,
                body: {
                    error: 'foo'
                }
            };

            const returnMessage = 'Failed to delete job: '
                  + `${JSON.stringify(fakeStopErrorResponse.body)}`;

            requestMock.yieldsAsync(null, fakeStopErrorResponse, fakeStopErrorResponse.body);

            return executor.stop({
                buildId: testBuildId
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.equal(err.message, returnMessage);
            });
        });
    });

    describe('start', () => {
        const fakeStartResponse = {
            statusCode: 201,
            body: {
                success: true
            }
        };

        beforeEach(() => {
            requestMock.yieldsAsync(null, fakeStartResponse, fakeStartResponse.body);
        });

        it('successfully calls start', () => {
            const postConfig = {
                uri: jobsUrl,
                method: 'POST',
                json: {
                    metadata: {
                        name: testBuildId,
                        container: testContainer,
                        launchVersion: testLaunchVersion,
                        serviceAccount: testServiceAccount
                    },
                    command: [
                        '/opt/screwdriver/launch http://api:8080 http://store:8080 abcdefg '
                        + '80754af91bfb6d1073585b046fe0a474ce868509'
                    ]
                },
                headers: {
                    Authorization: 'Bearer api_key'
                },
                strictSSL: false
            };

            return executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }).then(() => {
                assert.calledOnce(requestMock);
                assert.calledWith(requestMock, postConfig);
            });
        });

        it('returns error when request responds with error', () => {
            const error = new Error('lol');

            requestMock.yieldsAsync(error);

            return executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.deepEqual(err, error);
            });
        });

        it('returns body when request responds with error in response', () => {
            const returnResponse = {
                statusCode: 500,
                body: {
                    statusCode: 500,
                    message: 'lol'
                }
            };
            const returnMessage = `Failed to create job: ${JSON.stringify(returnResponse.body)}`;

            requestMock.yieldsAsync(null, returnResponse, returnResponse.body);

            return executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.equal(err.message, returnMessage);
            });
        });
    });
});
