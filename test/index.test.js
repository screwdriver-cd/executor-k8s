'use strict';
const assert = require('chai').assert;
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

const TEST_TIM_YAML = `
metadata:
  name: {{build_id}}
  job: {{job_id}}
  pipeline: {{pipeline_id}}
command:
- "/opt/screwdriver/launch {{git_org}} {{git_repo}} {{git_branch}} {{job_name}}"
`;

describe('index', () => {
    let Executor;
    let requestMock;
    let fsMock;
    let pipeMock;
    let executor;
    const testScmUrl = 'git@github.com:screwdriver-cd/hashr.git';
    const testBuildId = 'build_ad11234tag41fda';
    const testJobId = 'job_ad11234tag41fda';
    const testPipelineId = 'pipeline_ad11234tag41fda';
    const fakeResponse = {
        statusCode: 201,
        body: {
            success: true
        }
    };
    const jobsUrl = 'https://kubernetes/apis/batch/v1/namespaces/default/jobs';
    const podsUrl = 'https://kubernetes/apis/v1/namespaces/default/pods';

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

        pipeMock = {
            pipe: sinon.stub()
        };

        fsMock = {
            readFileSync: sinon.stub()
        };

        fsMock.readFileSync.withArgs('/etc/kubernetes/apikey/token').returns('api_key');
        fsMock.readFileSync.withArgs(sinon.match(/config\/job.yaml.tim/))
        .returns(TEST_TIM_YAML);

        mockery.registerMock('fs', fsMock);
        mockery.registerMock('request', requestMock);

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

    it('extends base class', () => {
        assert.isFunction(executor.stop);
        assert.isFunction(executor.start);
    });

    describe('start', () => {
        beforeEach(() => {
            requestMock.post.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        describe('successful requests', () => {
            it('with scmUrl containing branch', (done) => {
                const postConfig = {
                    json: {
                        metadata: {
                            name: testBuildId,
                            job: testJobId,
                            pipeline: testPipelineId
                        },
                        command: ['/opt/screwdriver/launch screwdriver-cd hashr addSD main']
                    },
                    headers: {
                        Authorization: 'Bearer api_key'
                    },
                    strictSSL: false
                };

                executor.start({
                    scmUrl: 'git@github.com:screwdriver-cd/hashr.git#addSD',
                    buildId: testBuildId,
                    jobId: testJobId,
                    pipelineId: testPipelineId
                }, (err) => {
                    assert.isNull(err);
                    assert.calledWith(requestMock.post, jobsUrl, postConfig);
                    done();
                });
            });

            it('with scmUrl without branch', (done) => {
                const postConfig = {
                    json: {
                        metadata: {
                            name: testBuildId,
                            job: testJobId,
                            pipeline: testPipelineId
                        },
                        command: ['/opt/screwdriver/launch screwdriver-cd hashr master main']
                    },
                    headers: {
                        Authorization: 'Bearer api_key'
                    },
                    strictSSL: false
                };

                executor.start({
                    scmUrl: testScmUrl,
                    buildId: testBuildId,
                    jobId: testJobId,
                    pipelineId: testPipelineId
                }, (err) => {
                    assert.isNull(err);
                    assert.calledWith(requestMock.post, jobsUrl, postConfig);
                    done();
                });
            });
        });

        it('returns error when request responds with error', (done) => {
            const error = new Error('lol');

            requestMock.post.yieldsAsync(error);

            executor.start({
                scmUrl: testScmUrl,
                buildId: testBuildId,
                jobId: testJobId,
                pipelineId: testPipelineId
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

            requestMock.post.yieldsAsync(null, returnResponse, returnResponse.body);

            executor.start({
                scmUrl: testScmUrl,
                buildId: testBuildId,
                jobId: testJobId,
                pipelineId: testPipelineId
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

            requestMock.get.yieldsAsync(error);
            executor.stream({
                buildId: testBuildId
            }, (err) => {
                assert.isOk(err);
                assert.notCalled(pipeMock.pipe);
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

            requestMock.get.withArgs(pod).yieldsAsync(null, returnResponse, returnResponse.body);
            executor.stream({
                buildId: testBuildId
            }, (err) => {
                assert.isOk(err);
                assert.notCalled(pipeMock.pipe);
                done();
            });
        });

        it('stream logs when podname is found', (done) => {
            const getConfig = {
                json: true,
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

            const returnFunc = (err) => {
                assert.isNull(err);
                assert.calledWith(requestMock.get, pod, getConfig);
                assert.calledWith(pipeMock.pipe, returnFunc);
                done();
            };

            requestMock.get.withArgs(pod).yieldsAsync(null, returnResponse, returnResponse.body);
            requestMock.get.withArgs(logUrl).returns(pipeMock);
            pipeMock.pipe.yieldsAsync(null);
            executor.stream({
                buildId: testBuildId
            }, returnFunc);
        });
    });
});
