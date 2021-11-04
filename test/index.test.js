'use strict';

const { assert } = require('chai');
const sinon = require('sinon');
const mockery = require('mockery');
const yaml = require('js-yaml');
const rewire = require('rewire');
const index = rewire('../index.js');
const _ = require('lodash');

sinon.assert.expose(assert, { prefix: '' });

const DEFAULT_BUILD_TIMEOUT = 90;
const MAX_BUILD_TIMEOUT = 120;
const TEST_TIM_YAML = `
metadata:
  name: {{build_id_with_prefix}}
  container: {{container}}
  launchImage: {{launcher_image}}
  serviceAccount: {{service_account}}
  cpu: {{cpu}}
  memory: {{memory}}
  dnsPolicy: {{dns_policy}}
  imagePullPolicy: {{image_pull_policy}}
spec:
  terminationGracePeriodSeconds: {{termination_grace_period_seconds}}
  containers:
  - name: beta_15
command:
- "/opt/sd/launch {{api_uri}} {{store_uri}} {{token}} {{build_timeout}} {{build_id}}"
`;

const SMALLEST_FLOAT64 = 2.2250738585072014e-308;
const MAXATTEMPTS = 5;

describe('index', function() {
    // Time not important. Only life important.
    this.timeout(5000);

    let Executor;
    let requestRetryMock;
    let fsMock;
    let executor;
    const testBuildId = 15;
    const testToken = 'abcdefg';
    const testApiUri = 'http://api:8080';
    const testStoreUri = 'http://store:8080';
    const testContainer = 'node:4';
    const testLaunchVersion = 'stable';
    const testLaunchImage = 'screwdrivercd/launcher';
    const testServiceAccount = 'default';
    const podsUrl = 'https://kubernetes.default/api/v1/namespaces/default/pods';
    const testSpec = {
        tolerations: [
            {
                key: 'key',
                value: 'value',
                effect: 'NoSchedule',
                operator: 'Equal'
            }
        ],
        affinity: {
            nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [
                        {
                            matchExpressions: [
                                {
                                    key: 'key',
                                    operator: 'In',
                                    values: ['value']
                                }
                            ]
                        }
                    ]
                }
            }
        }
    };
    const testPreferredSpec = {
        affinity: {
            nodeAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                    {
                        weight: 100,
                        preference: {
                            matchExpressions: [
                                {
                                    key: 'key',
                                    operator: 'In',
                                    values: ['value']
                                },
                                {
                                    key: 'foo',
                                    operator: 'In',
                                    values: ['bar']
                                }
                            ]
                        }
                    }
                ]
            }
        }
    };
    const testLifecycleHooksSpec = {
        terminationGracePeriodSeconds: 30,
        containers: [
            {
                name: 'beta_15',
                lifecycle: {
                    postStart: {
                        exec: {
                            command: ['/bin/sh', '-c', 'echo Hello World']
                        }
                    },
                    preStop: {
                        httpGet: {
                            path: '/gracefulShutDown',
                            port: 8000
                        }
                    }
                }
            }
        ]
    };
    const testAnnotations = {
        annotations: {
            key: 'value',
            key2: 'value2'
        }
    };
    const testLabels = {
        'network-egress': 'restricted',
        testEnv: true,
        app: 'screwdriver',
        sdbuild: 'beta_15',
        tier: 'builds'
    };
    let executorOptions;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        executorOptions = {
            ecosystem: {
                api: testApiUri,
                store: testStoreUri
            },
            kubernetes: {
                nodeSelectors: {},
                preferredNodeSelectors: {},
                lifecycleHooks: {}
            },
            fusebox: { retry: { minTimeout: 1 } },
            prefix: 'beta_'
        };
        requestRetryMock = sinon.stub().resolves({ statusCode: 200, body: {} });

        fsMock = {
            existsSync: sinon.stub(),
            readFileSync: sinon.stub()
        };

        fsMock.existsSync.returns(true);

        fsMock.readFileSync.withArgs('/var/run/secrets/kubernetes.io/serviceaccount/token').returns('api_key');
        fsMock.readFileSync.withArgs(sinon.match(/config\/pod.yaml.hbs/)).returns(TEST_TIM_YAML);

        mockery.registerMock('fs', fsMock);
        mockery.registerMock('screwdriver-request', requestRetryMock);
        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor(executorOptions);
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
                buildTimeout: 12,
                maxBuildTimeout: 220,
                token: 'api_key2',
                host: 'kubernetes2',
                serviceAccount: 'foobar',
                automountServiceAccountToken: 'true',
                terminationGracePeriodSeconds: 30,
                jobsNamespace: 'baz',
                resources: {
                    cpu: {
                        turbo: 10,
                        high: 8,
                        low: 1,
                        micro: 0.5
                    },
                    memory: {
                        turbo: 20,
                        high: 5,
                        low: 2,
                        micro: 1
                    }
                }
            },
            prefix: 'beta_',
            launchVersion: 'v1.2.3'
        });
        assert.equal(executor.buildTimeout, 12);
        assert.equal(executor.maxBuildTimeout, 220);
        assert.equal(executor.prefix, 'beta_');
        assert.equal(executor.token, 'api_key2');
        assert.equal(executor.host, 'kubernetes2');
        assert.equal(executor.launchVersion, 'v1.2.3');
        assert.equal(executor.serviceAccount, 'foobar');
        assert.equal(executor.automountServiceAccountToken, true);
        assert.equal(executor.jobsNamespace, 'baz');
        assert.equal(executor.turboCpu, 10);
        assert.equal(executor.highCpu, 8);
        assert.equal(executor.lowCpu, 1);
        assert.closeTo(executor.microCpu, 0.5, SMALLEST_FLOAT64);
        assert.equal(executor.turboMemory, 20);
        assert.equal(executor.highMemory, 5);
        assert.equal(executor.lowMemory, 2);
        assert.equal(executor.microMemory, 1);
        assert.equal(executor.terminationGracePeriodSeconds, 30);
    });

    it('allow empty options', () => {
        fsMock.existsSync.returns(false);
        executor = new Executor();
        assert.equal(executor.buildTimeout, DEFAULT_BUILD_TIMEOUT);
        assert.equal(executor.maxBuildTimeout, MAX_BUILD_TIMEOUT);
        assert.equal(executor.terminationGracePeriodSeconds, 30);
        assert.equal(executor.launchVersion, 'stable');
        assert.equal(executor.serviceAccount, 'default');
        assert.equal(executor.automountServiceAccountToken, false);
        assert.equal(executor.token, '');
        assert.equal(executor.host, 'kubernetes.default');
        assert.equal(executor.launchVersion, 'stable');
        assert.equal(executor.prefix, '');
        assert.equal(executor.highCpu, 6);
        assert.equal(executor.lowCpu, 2);
        assert.equal(executor.microCpu, 0.5);
        assert.equal(executor.highMemory, 12);
        assert.equal(executor.lowMemory, 2);
        assert.equal(executor.microMemory, 1);
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
            url: podsUrl,
            method: 'DELETE',
            searchParams: {
                labelSelector: `sdbuild=beta_${testBuildId}`
            },
            headers: {
                Authorization: 'Bearer api_key'
            },
            https: { rejectUnauthorized: false }
        };

        beforeEach(() => {
            requestRetryMock.resolves(fakeStopResponse);
        });

        it('calls breaker with correct config', () =>
            executor
                .stop({
                    buildId: testBuildId
                })
                .then(() => {
                    assert.calledWith(requestRetryMock, deleteConfig);
                    assert.calledOnce(requestRetryMock);
                }));

        it('returns error when breaker does', () => {
            const error = new Error('error');

            requestRetryMock.rejects(error);

            return executor
                .stop({
                    buildId: testBuildId
                })
                .then(
                    () => {
                        throw new Error('did not fail');
                    },
                    err => {
                        assert.deepEqual(err, error);
                        assert.equal(requestRetryMock.callCount, 5);
                    }
                );
        });

        it('returns error when response is non 200', () => {
            const fakeStopErrorResponse = {
                statusCode: 500,
                body: {
                    error: 'foo'
                }
            };

            const returnMessage = `Failed to delete pod:${JSON.stringify(fakeStopErrorResponse.body)}`;

            requestRetryMock.resolves(fakeStopErrorResponse);

            return executor
                .stop({
                    buildId: testBuildId
                })
                .then(
                    () => {
                        throw new Error('did not fail');
                    },
                    err => {
                        assert.equal(err.message, returnMessage);
                    }
                );
        });
    });

    describe('start', () => {
        let postConfig;
        let getConfig;
        let putConfig;
        let fakeStartConfig;
        let fakeStartResponse;
        let fakeGetResponse;
        let fakePutResponse;

        beforeEach(() => {
            postConfig = {
                url: podsUrl,
                method: 'POST',
                json: {
                    metadata: {
                        name: 'beta_15',
                        container: testContainer,
                        launchImage: `${testLaunchImage}:${testLaunchVersion}`,
                        serviceAccount: testServiceAccount,
                        cpu: 2000,
                        dnsPolicy: 'ClusterFirst',
                        imagePullPolicy: 'Always',
                        memory: 2,
                        labels: { app: 'screwdriver', sdbuild: 'beta_15', tier: 'builds' }
                    },
                    spec: {
                        containers: [{ name: 'beta_15' }],
                        terminationGracePeriodSeconds: 30
                    },
                    command: ['/opt/sd/launch http://api:8080 http://store:8080 abcdefg 90 15']
                },
                headers: {
                    Authorization: 'Bearer api_key'
                },
                https: { rejectUnauthorized: false }
            };
            getConfig = {
                url: `${podsUrl}/testpod/status`,
                method: 'GET',
                headers: {
                    Authorization: 'Bearer api_key'
                },
                https: { rejectUnauthorized: false }
            };
            putConfig = {
                url: `${testApiUri}/v4/builds/${testBuildId}`,
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${testToken}`
                },
                json: {},
                https: { rejectUnauthorized: false },
                retry: {
                    limit: MAXATTEMPTS
                }
            };
            fakeStartConfig = {
                annotations: {},
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            };
            fakePutResponse = {
                id: testBuildId
            };
            fakeStartResponse = {
                statusCode: 201,
                body: {
                    metadata: {
                        name: 'testpod'
                    },
                    success: true
                }
            };
            fakeGetResponse = {
                statusCode: 200,
                body: {
                    status: {
                        phase: 'running'
                    },
                    spec: {
                        nodeName: 'node1.my.k8s.cluster.com'
                    },
                    metadata: {
                        name: 'beta_15'
                    }
                }
            };

            requestRetryMock.withArgs(sinon.match({ method: 'POST' })).resolves(fakeStartResponse);
            requestRetryMock.withArgs(sinon.match({ method: 'GET' })).resolves(fakeGetResponse);
            requestRetryMock.withArgs(sinon.match({ method: 'PUT' })).resolves(fakePutResponse);
        });

        it('successfully calls start', () => {
            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('successfully calls start and update hostname and imagePullStartTime', () => {
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const clock = sinon.useFakeTimers({
                now: dateNow,
                shouldAdvanceTime: true
            });

            putConfig.json.stats = {
                hostname: 'node1.my.k8s.cluster.com',
                imagePullStartTime: isoTime
            };

            return executor.start(fakeStartConfig).then(() => {
                assert.equal(requestRetryMock.callCount, 3);
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
                assert.calledWith(requestRetryMock.thirdCall, sinon.match(putConfig));
                clock.restore();
            });
        });

        it('does not push to retry queue if status is not pending', () => {
            fakeGetResponse.body.status.phase = 'running';

            return executor
                .start(fakeStartConfig)
                .then(() => {
                    assert.equal(requestRetryMock.callCount, 3);
                    assert.calledWith(requestRetryMock.firstCall, postConfig);
                    assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
                })
                .catch(() => {
                    throw new Error('should not fail');
                });
        });

        it('sets the memory appropriately when ram is set to HIGH', () => {
            postConfig.json.metadata.cpu = 2000;
            postConfig.json.metadata.memory = 12;
            fakeStartConfig.annotations['beta.screwdriver.cd/ram'] = 'HIGH';

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets proper DNS policy required by cluster admin', () => {
            postConfig.json.metadata.dnsPolicy = 'Default';

            executorOptions.kubernetes.dnsPolicy = 'Default';

            executor = new Executor(executorOptions);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets proper Image Pull policy required by cluster admin', () => {
            postConfig.json.metadata.imagePullPolicy = 'IfNotPresent';

            executorOptions.kubernetes.imagePullPolicy = 'IfNotPresent';

            executor = new Executor(executorOptions);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the memory appropriately when ram is set to MICRO', () => {
            postConfig.json.metadata.cpu = 2000;
            postConfig.json.metadata.memory = 1;
            fakeStartConfig.annotations['beta.screwdriver.cd/ram'] = 'MICRO';

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the memory appropriately when ram is set to Integer', () => {
            postConfig.json.metadata.cpu = 2000;
            postConfig.json.metadata.memory = 16;
            fakeStartConfig.annotations['beta.screwdriver.cd/ram'] = 64;

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the cpu appropriately when cpu is set to HIGH', () => {
            postConfig.json.metadata.cpu = 6000;
            postConfig.json.metadata.memory = 2;
            fakeStartConfig.annotations['beta.screwdriver.cd/cpu'] = 'HIGH';

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the cpu appropriately when cpu is set to MICRO', () => {
            postConfig.json.metadata.cpu = 500;
            postConfig.json.metadata.memory = 2;
            fakeStartConfig.annotations['beta.screwdriver.cd/cpu'] = 'MICRO';

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the build timeout to default build timeout if not configured by user', () => {
            postConfig.json.command = [
                `/opt/sd/launch http://api:8080 http://store:8080 abcdefg ${DEFAULT_BUILD_TIMEOUT} 15`
            ];

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the build timeout if configured by user', () => {
            const userTimeout = 45;

            postConfig.json.command = [`/opt/sd/launch http://api:8080 http://store:8080 abcdefg ${userTimeout} 15`];
            fakeStartConfig.annotations = { 'beta.screwdriver.cd/timeout': userTimeout };

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the timeout to maxBuildTimeout if user specified a higher timeout', () => {
            fakeStartConfig.annotations = { 'beta.screwdriver.cd/timeout': 220 };
            postConfig.json.command = [
                `/opt/sd/launch http://api:8080 http://store:8080 abcdefg ${MAX_BUILD_TIMEOUT} 15`
            ];

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets the terminationGracePeriodSeconds appropriately when annotation is set', () => {
            postConfig.json.spec.terminationGracePeriodSeconds = 90;
            fakeStartConfig.annotations['screwdriver.cd/terminationGracePeriodSeconds'] = 90;

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets annotations with appropriate annotations config', () => {
            const options = _.assign({}, executorOptions, {
                kubernetes: {
                    annotations: { key: 'value', key2: 'value2' }
                }
            });

            executor = new Executor(options);
            postConfig.json.metadata.annotations = testAnnotations.annotations;

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets lifecycle configs for the target container', () => {
            const options = _.assign({}, executorOptions, {
                kubernetes: {
                    lifecycleHooks: {
                        postStart: {
                            exec: {
                                command: ['/bin/sh', '-c', 'echo Hello World']
                            }
                        },
                        preStop: {
                            httpGet: {
                                path: '/gracefulShutDown',
                                port: 8000
                            }
                        }
                    }
                }
            });

            executor = new Executor(options);
            postConfig.json.spec = _.assign({}, postConfig.json.spec, testLifecycleHooksSpec);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets tolerations and pod labels appropriately', () => {
            const options = _.assign({}, executorOptions, {
                kubernetes: {
                    podLabels: { 'network-egress': 'restricted', testEnv: true }
                }
            });

            executor = new Executor(options);
            postConfig.json.metadata.labels = testLabels;

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets tolerations and node affinity with appropriate node config', () => {
            const options = _.assign({}, executorOptions, {
                kubernetes: {
                    nodeSelectors: { key: 'value' }
                }
            });

            executor = new Executor(options);
            postConfig.json.spec = _.assign({}, postConfig.json.spec, testSpec);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets preferred node affinity with appropriate node config', () => {
            const options = _.assign({}, executorOptions, {
                kubernetes: {
                    preferredNodeSelectors: { key: 'value', foo: 'bar' }
                }
            });

            executor = new Executor(options);
            postConfig.json.spec = _.assign({}, postConfig.json.spec, testPreferredSpec);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('sets node affinity and preferred node affinity', () => {
            const spec = _.merge({}, testSpec, testPreferredSpec);
            const options = _.assign({}, executorOptions, {
                kubernetes: {
                    nodeSelectors: { key: 'value' },
                    preferredNodeSelectors: { key: 'value', foo: 'bar' }
                }
            });

            executor = new Executor(options);
            postConfig.json.spec = _.assign({}, postConfig.json.spec, spec);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
            });
        });

        it('update build status message when pod status is pending', () => {
            fakeGetResponse.body.status.phase = 'pending';
            fakeGetResponse.body.spec = {};
            putConfig.json.statusMessage = 'Waiting for resources to be available.';

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
                assert.calledWith(requestRetryMock.thirdCall, sinon.match(putConfig));
            });
        });

        it('returns error when request responds with error', () => {
            const error = new Error('lol');

            requestRetryMock.withArgs(postConfig).yieldsAsync(error);

            return executor.start(fakeStartConfig).then(
                () => {
                    throw new Error('did not fail');
                },
                err => {
                    assert.deepEqual(err, error);
                }
            );
        });

        it('returns error when not able to get pod status', () => {
            const returnResponse = {
                statusCode: 500,
                body: {
                    statusCode: 500,
                    message: 'cannot get pod status'
                }
            };
            const returnMessage = `Failed to get pod status:${JSON.stringify(returnResponse.body)}`;

            requestRetryMock.withArgs(getConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(
                () => {
                    throw new Error('did not fail');
                },
                err => {
                    assert.equal(err.message, returnMessage);
                }
            );
        });

        it('returns error when pod status is failed', () => {
            const returnResponse = {
                statusCode: 200,
                body: {
                    status: {
                        phase: 'failed'
                    },
                    metadata: {
                        name: 'pod1'
                    }
                }
            };
            const returnMessage = 'Failed to create pod. Pod status is: failed';

            requestRetryMock.withArgs(getConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(
                () => {
                    throw new Error('did not fail');
                },
                err => {
                    assert.equal(err.message, returnMessage);
                }
            );
        });

        it('pushes to retry queue when pod status is pending', () => {
            const returnResponse = {
                statusCode: 200,
                body: {
                    status: {
                        phase: 'pending',
                        containerStatuses: [
                            {
                                state: {
                                    waiting: {
                                        reason: 'PodInitializing'
                                    }
                                }
                            }
                        ]
                    },
                    metadata: {
                        name: 'pod1'
                    },
                    spec: {
                        nodeName: 'node1.my.k8s.cluster.com'
                    }
                }
            };

            requestRetryMock.withArgs(getConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(() => {
                assert.calledWith(requestRetryMock.firstCall, postConfig);
                assert.calledWith(requestRetryMock.secondCall, sinon.match(getConfig));
                assert.calledWith(requestRetryMock.lastCall, sinon.match(putConfig));
            });
        });

        it('pushes to retry queue and does not error when pod is pending', () => {
            const returnResponse = {
                statusCode: 200,
                body: {
                    status: {
                        phase: 'pending',
                        containerStatuses: [
                            {
                                state: {
                                    waiting: {
                                        reason: 'CreateContainerConfigError',
                                        message: 'create container config error'
                                    }
                                }
                            }
                        ]
                    },
                    metadata: {
                        name: 'pod1'
                    }
                }
            };

            requestRetryMock.withArgs(getConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(
                () => {},
                () => {
                    throw new Error('should not fail');
                }
            );
        });

        it('returns error when pod terminated and status is failed', () => {
            const returnResponse = {
                statusCode: 200,
                body: {
                    status: {
                        phase: 'failed',
                        containerStatuses: [
                            {
                                state: {
                                    terminated: {
                                        reason: 'Error'
                                    }
                                }
                            }
                        ]
                    },
                    metadata: {
                        name: 'pod1'
                    }
                }
            };

            const returnMessage = 'Failed to create pod. Pod status is: failed';

            requestRetryMock.withArgs(getConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(
                () => {
                    throw new Error('did not fail');
                },
                err => {
                    assert.equal(err.message, returnMessage);
                }
            );
        });

        it('sets error when pod status is failed', () => {
            const returnResponse = {
                statusCode: 200,
                body: {
                    status: {
                        phase: 'failed'
                    },
                    metadata: {
                        name: 'pod1'
                    }
                }
            };
            const returnMessage = 'Failed to create pod. Pod status is: failed';

            requestRetryMock.withArgs(getConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(
                () => {
                    throw new Error('did not fail');
                },
                err => {
                    assert.equal(err.message, returnMessage);
                }
            );
        });

        it('returns body when request responds with error in response', () => {
            const returnResponse = {
                statusCode: 500,
                body: {
                    statusCode: 500,
                    message: 'lol'
                },
                metadata: {
                    name: 'pod1'
                }
            };
            const returnMessage = `Failed to create pod:${JSON.stringify(returnResponse.body)}`;

            requestRetryMock.withArgs(postConfig).resolves(returnResponse);

            return executor.start(fakeStartConfig).then(
                () => {
                    throw new Error('did not fail');
                },
                err => {
                    assert.equal(err.message, returnMessage);
                }
            );
        });

    });

    describe('periodic', () => {
        it('resolves to null when calling periodic start', () =>
            executor.startPeriodic().then(res => assert.isNull(res)));

        it('resolves to null when calling periodic stop', () =>
            executor.stopPeriodic().then(res => assert.isNull(res)));
    });

    describe('frozen', () => {
        it('resolves to null when calling frozen start', () => executor.startFrozen().then(res => assert.isNull(res)));

        it('resolves to null when calling frozen stop', () => executor.stopFrozen().then(res => assert.isNull(res)));
    });

    describe('setNodeSelector', () => {
        // eslint-disable-next-line no-underscore-dangle
        const setNodeSelector = index.__get__('setNodeSelector');

        let nodeSelectors;
        let fakeConfig;

        beforeEach(() => {
            nodeSelectors = null;
            fakeConfig = yaml.safeLoad(TEST_TIM_YAML);
        });

        it('does nothing if nodeSelector is not set', () => {
            const updatedConfig = JSON.parse(JSON.stringify(fakeConfig));

            setNodeSelector(fakeConfig, nodeSelectors);
            assert.deepEqual(fakeConfig, updatedConfig);
        });

        it('updates config with tolerations', () => {
            const updatedConfig = JSON.parse(JSON.stringify(fakeConfig));

            updatedConfig.spec = _.assign({}, updatedConfig.spec, testSpec);
            nodeSelectors = { key: 'value' };

            setNodeSelector(fakeConfig, nodeSelectors);
            assert.deepEqual(fakeConfig, updatedConfig);
        });
    });

    describe('setPreferredNodeSelector', () => {
        // eslint-disable-next-line no-underscore-dangle
        const setPreferredNodeSelector = index.__get__('setPreferredNodeSelector');

        let nodeSelectors;
        let fakeConfig;

        beforeEach(() => {
            nodeSelectors = null;
            fakeConfig = yaml.safeLoad(TEST_TIM_YAML);
        });

        it('does nothing if preferredNodeSelector is not set', () => {
            const updatedConfig = JSON.parse(JSON.stringify(fakeConfig));

            setPreferredNodeSelector(fakeConfig, nodeSelectors);
            assert.deepEqual(fakeConfig, updatedConfig);
        });

        it('updates config with preferred node settings', () => {
            const updatedConfig = JSON.parse(JSON.stringify(fakeConfig));

            updatedConfig.spec = _.assign({}, updatedConfig.spec, testPreferredSpec);
            nodeSelectors = { key: 'value', foo: 'bar' };

            setPreferredNodeSelector(fakeConfig, nodeSelectors);
            assert.deepEqual(fakeConfig, updatedConfig);
        });
    });

    describe('setLifecycleHooks', () => {
        // eslint-disable-next-line no-underscore-dangle
        const setLifecycleHooks = index.__get__('setLifecycleHooks');

        let lifecycleHooks;
        let fakeConfig;

        beforeEach(() => {
            lifecycleHooks = {
                postStart: {
                    exec: {
                        command: ['/bin/sh', '-c', 'echo Hello World']
                    }
                },
                preStop: {
                    httpGet: {
                        path: '/gracefulShutDown',
                        port: 8000
                    }
                }
            };
            fakeConfig = yaml.safeLoad(TEST_TIM_YAML);
        });

        it('does nothing if no build container is found', () => {
            const updatedConfig = JSON.parse(JSON.stringify(fakeConfig));

            setLifecycleHooks(fakeConfig, lifecycleHooks, 'do_no_exist');
            assert.deepEqual(fakeConfig, updatedConfig);
        });

        it('updates config with container lifecycle settings', () => {
            const updatedConfig = JSON.parse(JSON.stringify(fakeConfig));

            fakeConfig.spec = { containers: [{ name: 'beta_15' }], terminationGracePeriodSeconds: 30 };
            updatedConfig.spec = _.assign({}, updatedConfig.spec, testLifecycleHooksSpec);

            setLifecycleHooks(fakeConfig, lifecycleHooks, 'beta_15');
            assert.deepEqual(fakeConfig, updatedConfig);
        });
    });

    describe('verify', async () => {
        let fakeVerifyConfig;
        let getPodsConfig;
        let fakeGetPodsResponse;

        beforeEach(() => {
            fakeVerifyConfig = {
                annotations: {},
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            };
            getPodsConfig = {
                url: `${podsUrl}`,
                method: 'GET',
                headers: {
                    Authorization: 'Bearer api_key'
                },
                https: { rejectUnauthorized: false },
                searchParams: {
                    labelSelector: `sdbuild=beta_${testBuildId}`
                }
            };
            fakeGetPodsResponse = {
                statusCode: 200,
                body: {
                    items: [
                        {
                            status: {
                                phase: 'pending'
                            },
                            spec: {
                                nodeName: 'node1.my.k8s.cluster.com'
                            },
                            metadata: {
                                name: 'beta_15-achb'
                            }
                        }
                    ]
                }
            };
            requestRetryMock.withArgs(sinon.match({ method: 'GET' })).resolves(fakeGetPodsResponse);
        });
        it('gets all pods for given buildid', async () => {
            await executor.verify(fakeVerifyConfig);
            assert.calledOnce(requestRetryMock);
            assert.calledWith(requestRetryMock, sinon.match(getPodsConfig));
        });

        it('return message when pod waiting reason is CrashLoopBackOff', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'CrashLoopBackOff',
                                    message: 'crash loop backoff'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please reach out to your cluster admin for help.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod waiting reason is CreateContainerConfigError', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'CreateContainerConfigError',
                                    message: 'create container config error'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please reach out to your cluster admin for help.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod waiting reason is CreateContainerError', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'CreateContainerError',
                                    message: 'create container error'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please reach out to your cluster admin for help.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod waiting reason is ErrImagePull', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'ErrImagePull',
                                    message: 'can not pull image'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please check if your image is valid.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod waiting reason is ImagePullBackOff', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'ImagePullBackOff',
                                    message: 'can not pull image'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please check if your image is valid.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod waiting reason is InvalidImageName', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'InvalidImageName',
                                    message: 'invalid reference format'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please check if your image is valid.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod waiting reason is StartError', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'StartError',
                                    message: 'mount path errors'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Build failed to start. Please reach out to your cluster admin for help.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod terminated and status is failed', async () => {
            const pod = {
                status: {
                    phase: 'failed',
                    containerStatuses: [
                        {
                            state: {
                                terminated: {
                                    reason: 'Error'
                                }
                            }
                        }
                    ]
                }
            };

            fakeGetPodsResponse.body.items.push(pod);

            const expectedMessage = 'Failed to create pod. Pod status is: failed';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('return message when pod status is failed', async () => {
            const pod = {
                status: {
                    phase: 'failed'
                }
            };

            fakeGetPodsResponse.body.items.push(pod);
            const expectedMessage = 'Failed to create pod. Pod status is: failed';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            const actualMessage = await executor.verify(fakeVerifyConfig);

            assert.equal(expectedMessage, actualMessage);
        });

        it('returns error when pod is still initializing', async () => {
            const pod = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'PodIntializing',
                                    message: 'pod is initializing'
                                }
                            }
                        }
                    ]
                }
            };
            const expectedMessage = 'Build failed to start. Pod is still intializing.';

            fakeGetPodsResponse.body.items.push(pod);
            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            try {
                await executor.verify(fakeVerifyConfig);
            } catch (error) {
                assert.equal(expectedMessage, error);
            }
        });

        it('checks all pods for waiting reason', async () => {
            const pod1 = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'PodInitializing',
                                    message: 'pod is initializing'
                                }
                            }
                        }
                    ],
                    metadata: {
                        name: 'beta_15-dsvds'
                    }
                }
            };

            fakeGetPodsResponse.body.items.push(pod1);
            const pod2 = {
                status: {
                    phase: 'pending',
                    containerStatuses: [
                        {
                            state: {
                                waiting: {
                                    reason: 'ErrImagePull',
                                    message: 'can not pull image'
                                }
                            }
                        }
                    ],
                    metadata: {
                        name: 'beta_15-degg'
                    }
                }
            };

            fakeGetPodsResponse.body.items.push(pod2);

            const expectedMessage = 'Build failed to start. Please check if your image is valid.';

            requestRetryMock.withArgs(getPodsConfig).resolves(fakeGetPodsResponse);

            try {
                const actualMessage = await executor.verify(fakeVerifyConfig);

                assert.equal(expectedMessage, actualMessage);
            } catch (error) {
                throw new Error('should not fail');
            }
        });
    });
});
