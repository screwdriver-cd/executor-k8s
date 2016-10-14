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
  logVersion: {{log_version}}
  serviceAccount: {{service_account}}
command:
- "/opt/screwdriver/launch {{api_uri}} {{token}} {{build_id}}"
`;

/**
 * Stub for Readable wrapper
 * @method ReadableMock
 */
function ReadableMock() {}
/**
 * Stub for circuit-fuses wrapper
 * @method BreakerMock
 */
function BreakerMock() {}

describe('index', () => {
    let Executor;
    let requestMock;
    let fsMock;
    let executor;
    let readableMock;
    let breakRunMock;
    const testBuildId = '80754af91bfb6d1073585b046fe0a474ce868509';
    const testToken = 'abcdefg';
    const testApiUri = 'http://localhost:8080';
    const testContainer = 'node:4';
    const testLaunchVersion = 'stable';
    const testLogVersion = 'stable';
    const testServiceAccount = 'default';
    const jobsUrl = 'https://kubernetes/apis/batch/v1/namespaces/default/jobs';

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = {
            post: sinon.stub(),
            get: sinon.stub()
        };

        fsMock = {
            readFileSync: sinon.stub()
        };

        readableMock = {
            wrap: sinon.stub()
        };

        breakRunMock = {
            runCommand: sinon.stub(),
            stats: sinon.stub().returns({
                requests: {
                    total: 1,
                    timeouts: 2,
                    success: 3,
                    failure: 4,
                    concurrent: 5,
                    averageTime: 6
                },
                breaker: {
                    isClosed: false
                }
            })
        };

        BreakerMock.prototype = breakRunMock;
        ReadableMock.prototype.wrap = readableMock.wrap;

        fsMock.readFileSync.withArgs('/var/run/secrets/kubernetes.io/serviceaccount/token')
            .returns('api_key');
        fsMock.readFileSync.withArgs(sinon.match(/config\/job.yaml.tim/))
            .returns(TEST_TIM_YAML);

        mockery.registerMock('fs', fsMock);
        mockery.registerMock('request', requestMock);
        mockery.registerMock('circuit-fuses', BreakerMock);

        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor();
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
        assert.equal(executor.logVersion, 'stable');
        assert.equal(executor.serviceAccount, 'default');
        assert.equal(executor.token, 'api_key');
        assert.equal(executor.host, 'kubernetes');
        executor = new Executor({
            token: 'api_key2',
            host: 'kubernetes2',
            launchVersion: 'v1.2.3',
            logVersion: 'v2.3.4',
            serviceAccount: 'foobar'
        });
        assert.equal(executor.token, 'api_key2');
        assert.equal(executor.host, 'kubernetes2');
        assert.equal(executor.launchVersion, 'v1.2.3');
        assert.equal(executor.logVersion, 'v2.3.4');
        assert.equal(executor.serviceAccount, 'foobar');
    });

    it('extends base class', () => {
        assert.isFunction(executor.stop);
        assert.isFunction(executor.start);
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(executor.stats(), {
                requests: {
                    total: 1,
                    timeouts: 2,
                    success: 3,
                    failure: 4,
                    concurrent: 5,
                    averageTime: 6
                },
                breaker: {
                    isClosed: false
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
            breakRunMock.runCommand.yieldsAsync(null, fakeStopResponse, fakeStopResponse.body);
        });

        it('calls breaker with correct config', () => (
            executor.stop({
                buildId: testBuildId
            }).then(() => {
                assert.calledOnce(breakRunMock.runCommand);
                assert.calledWith(breakRunMock.runCommand, deleteConfig);
            })
        ));

        it('returns error when breaker does', () => {
            const error = new Error('error');

            breakRunMock.runCommand.yieldsAsync(error);

            return executor.stop({
                buildId: testBuildId
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.deepEqual(err, error);
                assert.calledOnce(breakRunMock.runCommand);
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

            breakRunMock.runCommand.yieldsAsync(null, fakeStopErrorResponse);

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
            breakRunMock.runCommand.yieldsAsync(null, fakeStartResponse, fakeStartResponse.body);
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
                        logVersion: testLogVersion,
                        serviceAccount: testServiceAccount
                    },
                    command: [
                        `/opt/screwdriver/launch ${testApiUri} ${testToken} ${testBuildId}`
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
                assert.calledOnce(breakRunMock.runCommand);
                assert.calledWith(breakRunMock.runCommand, postConfig);
            });
        });

        it('returns error when request responds with error', () => {
            const error = new Error('lol');

            breakRunMock.runCommand.yieldsAsync(error);

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

            breakRunMock.runCommand.yieldsAsync(null, returnResponse);

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
