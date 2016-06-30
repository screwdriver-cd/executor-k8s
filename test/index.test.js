'use strict';
const assert = require('chai').assert;
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

const TEST_TIM_YAML = `
command:
- "/opt/screwdriver/launch {{git_org}} {{git_repo}} {{git_branch}} {{job_name}}"
`;

describe('start', () => {
    let Executor;
    let requestMock;
    let fsMock;
    let executor;
    const fakeResponse = {
        statusCode: 201,
        body: {
            success: true
        }
    };
    const jobsUrl = 'https://kubernetes/apis/batch/v1/namespaces/default/jobs';

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = {
            post: sinon.stub()
        };
        fsMock = {
            readFileSync: sinon.stub()
        };

        requestMock.post.yieldsAsync(null, fakeResponse, fakeResponse.body);
        fsMock.readFileSync.withArgs('/etc/kubernetes/apikey').returns('api_key');
        fsMock.readFileSync.withArgs('./config/job.yaml.tim').returns(TEST_TIM_YAML);

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

    describe('successful requests', () => {
        it('with scmUrl containing branch', (done) => {
            const postConfig = {
                json: {
                    command: ['/opt/screwdriver/launch screwdriver-cd hashr addSD main']
                },
                headers: {
                    Authorization: 'Bearer api_key'
                },
                strictSSL: false
            };

            executor.start({
                scmUrl: 'git@github.com:screwdriver-cd/hashr.git#addSD'
            }, (err) => {
                assert.isNull(err);
                assert.calledWith(requestMock.post, jobsUrl, postConfig);
                done();
            });
        });

        it('with scmUrl without branch', (done) => {
            const postConfig = {
                json: {
                    command: ['/opt/screwdriver/launch screwdriver-cd hashr master main']
                },
                headers: {
                    Authorization: 'Bearer api_key'
                },
                strictSSL: false
            };

            executor.start({
                scmUrl: 'git@github.com:screwdriver-cd/hashr.git'
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
            scmUrl: 'git@github.com:screwdriver-cd/hashr.git'
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

        requestMock.post.yieldsAsync(null, returnResponse, returnResponse.body);

        executor.start({
            scmUrl: 'git@github.com:screwdriver-cd/hashr.git'
        }, (err, response) => {
            assert.notOk(response);
            assert.deepEqual(err, returnResponse.body);
            done();
        });
    });
});
