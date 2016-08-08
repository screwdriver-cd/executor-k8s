'use strict';
const assert = require('chai').assert;
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

const TEST_TIM_YAML = `
metadata:
  name: {{build_id}}
  container: {{container}}
  version: {{version}}
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
    const testVersion = 'latest';
    const jobsUrl = 'https://kubernetes/apis/batch/v1/namespaces/default/jobs';
    const podsUrl = 'https://kubernetes/api/v1/namespaces/default/pods';

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

        breakRunMock = sinon.stub();

        BreakerMock.prototype.runCommand = breakRunMock;
        ReadableMock.prototype.wrap = readableMock.wrap;

        fsMock.readFileSync.withArgs('/etc/kubernetes/apikey/token').returns('api_key');
        fsMock.readFileSync.withArgs(sinon.match(/config\/job.yaml.tim/))
            .returns(TEST_TIM_YAML);

        mockery.registerMock('stream', {
            Readable: ReadableMock
        });
        mockery.registerMock('fs', fsMock);
        mockery.registerMock('request', requestMock);
        mockery.registerMock('circuit-fuses', BreakerMock);

        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor({
            token: 'api_key',
            host: 'kubernetes'
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
        assert.equal(executor.version, 'latest');
        executor = new Executor({
            token: 'api_key',
            host: 'kubernetes',
            version: 'v1.2.3'
        });
        assert.equal(executor.version, 'v1.2.3');
    });

    it('extends base class', () => {
        assert.isFunction(executor.stop);
        assert.isFunction(executor.start);
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
            breakRunMock.yieldsAsync(null, fakeStopResponse, fakeStopResponse.body);
        });

        it('calls breaker with correct config', (done) => {
            executor.stop({
                buildId: testBuildId
            }, (err) => {
                assert.isNull(err);
                assert.calledOnce(breakRunMock);
                assert.calledWith(breakRunMock, deleteConfig);
                done();
            });
        });

        it('returns error when breaker does', (done) => {
            const error = new Error('error');

            breakRunMock.yieldsAsync(error);
            executor.stop({
                buildId: testBuildId
            }, (err) => {
                assert.deepEqual(err, error);
                assert.calledOnce(breakRunMock);
                done();
            });
        });

        it('returns error when response is non 200', (done) => {
            const fakeStopErrorResponse = {
                statusCode: 500,
                body: {
                    error: 'foo'
                }
            };

            const returnMessage = 'Failed to delete job: '
                  + `${JSON.stringify(fakeStopErrorResponse.body)}`;

            breakRunMock.yieldsAsync(null, fakeStopErrorResponse);

            executor.stop({
                buildId: testBuildId
            }, (err) => {
                assert.equal(err.message, returnMessage);
                done();
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
            breakRunMock.yieldsAsync(null, fakeStartResponse, fakeStartResponse.body);
        });

        it('successfully calls start', (done) => {
            const postConfig = {
                uri: jobsUrl,
                method: 'POST',
                json: {
                    metadata: {
                        name: testBuildId,
                        container: testContainer,
                        version: testVersion
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

            executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }, (err) => {
                assert.isNull(err);
                assert.calledOnce(breakRunMock);
                assert.calledWith(breakRunMock, postConfig);
                done();
            });
        });

        it('returns error when request responds with error', (done) => {
            const error = new Error('lol');

            breakRunMock.yieldsAsync(error);

            executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }, (err) => {
                assert.deepEqual(err, error);
                done();
            });
        });

        it('returns body when request responds with error in response', (done) => {
            const returnResponse = {
                statusCode: 500,
                body: {
                    statusCode: 500,
                    message: 'lol'
                }
            };
            const returnMessage = `Failed to create job: ${JSON.stringify(returnResponse.body)}`;

            breakRunMock.yieldsAsync(null, returnResponse);

            executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }, (err, response) => {
                assert.notOk(response);
                assert.equal(err.message, returnMessage);
                done();
            });
        });
    });

    describe('stream', () => {
        const pod = `${podsUrl}?labelSelector=sdbuild=${testBuildId}`;
        const logUrl = `${podsUrl}/mypod/log?container=build&follow=true&pretty=true`;

        it('reply with error when it fails to get pod', (done) => {
            const error = new Error('lol');

            breakRunMock.yieldsAsync(error);
            executor.stream({
                buildId: testBuildId
            }, (err) => {
                assert.isOk(err);
                done();
            });
        });

        it('reply with error when podname is not found', (done) => {
            const returnResponse = {
                statusCode: 200,
                body: {
                    items: []
                }
            };

            breakRunMock.yieldsAsync(null, returnResponse);
            executor.stream({
                buildId: testBuildId
            }, (err) => {
                assert.isOk(err);
                done();
            });
        });

        it('stream logs when podname is found', (done) => {
            const getConfig = {
                url: pod,
                json: true,
                headers: {
                    Authorization: 'Bearer api_key'
                },
                strictSSL: false
            };
            const logConfig = {
                url: logUrl,
                headers: {
                    Authorization: 'Bearer api_key'
                },
                strictSSL: false
            };
            const returnResponse = {
                statusCode: 200,
                body: {
                    items: [{
                        metadata: {
                            name: 'mypod'
                        }
                    }]
                }
            };
            const logGetMock = {
                mock: 'thing'
            };
            const readWrapMock = {
                mock: 'thing2'
            };

            breakRunMock.withArgs(getConfig)
                .yieldsAsync(null, returnResponse);
            requestMock.get.withArgs(logConfig).returns(logGetMock);
            readableMock.wrap.returns(readWrapMock);

            executor.stream({
                buildId: testBuildId
            }, (err, stream) => {
                assert.isNull(err);
                assert.calledOnce(breakRunMock);
                assert.calledOnce(requestMock.get);
                assert.calledWith(breakRunMock, getConfig);
                assert.calledWith(requestMock.get, logConfig);
                assert.calledWith(readableMock.wrap, logGetMock);
                assert.deepEqual(stream, readWrapMock);
                done();
            });
        });
    });
});
