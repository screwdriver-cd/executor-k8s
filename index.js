'use strict';

const Executor = require('screwdriver-executor-base');
const Fusebox = require('circuit-fuses').breaker;
const fs = require('fs');
const hoek = require('@hapi/hoek');
const path = require('path');
const randomstring = require('randomstring');
const request = require('screwdriver-request');
const handlebars = require('handlebars');
const yaml = require('js-yaml');
const _ = require('lodash');
const jwt = require('jsonwebtoken');
const logger = require('screwdriver-logger');

const DEFAULT_BUILD_TIMEOUT = 90; // 90 minutes
const MAX_BUILD_TIMEOUT = 120; // 120 minutes
const DEFAULT_MAXATTEMPTS = 5;
const DEFAULT_RETRYDELAY = 3000;
const CPU_RESOURCE = 'cpu';
const RAM_RESOURCE = 'ram';
const DISK_SPEED_RESOURCE = 'diskSpeed';
const ANNOTATE_BUILD_TIMEOUT = 'timeout';
const TOLERATIONS_PATH = 'spec.tolerations';
const AFFINITY_NODE_SELECTOR_PATH =
    'spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions';
const AFFINITY_PREFERRED_NODE_SELECTOR_PATH =
    'spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution';
const PREFERRED_WEIGHT = 100;
const DISK_CACHE_STRATEGY = 'disk';
const DOCKER_ENABLED_KEY = 'dockerEnabled';
const DOCKER_MEMORY_RESOURCE = 'dockerRam';
const DOCKER_CPU_RESOURCE = 'dockerCpu';
const ANNOTATIONS_PATH = 'metadata.annotations';
const LABELS_PATH = 'metadata.labels';
const CONTAINER_WAITING_REASON_PATH = 'status.containerStatuses.0.state.waiting.reason';
const PR_JOBNAME_REGEX_PATTERN = /^PR-([0-9]+)(?::[\w-]+)?$/gi;
const TERMINATION_GRACE_PERIOD_SECONDS = 'terminationGracePeriodSeconds';
const POD_STATUSQUERY_RETRYDELAY_MS = 500;

/**
 * Parses annotations config and update intended annotations
 * @param {Object} podConfig      k8s pod config
 * @param {Object} annotations    key-value pairs of annotations
 */
function setAnnotations(podConfig, annotations) {
    if (!annotations || typeof annotations !== 'object' || Object.keys(annotations).length === 0) {
        return;
    }

    _.set(podConfig, ANNOTATIONS_PATH, annotations);
}

/**
 * Sets default and custom pod labels
 * @param {Object} podConfig          k8s pod config
 * @param {Object} podLabels          key-value pairs of labels
 * @param {String} buildContainerName build container name
 */
function setLabels(podConfig, podLabels, buildContainerName) {
    const defaultLabels = { app: 'screwdriver', tier: 'builds', sdbuild: buildContainerName };
    let labels = defaultLabels;

    if (podLabels && typeof podLabels === 'object' && Object.keys(podLabels).length > 0) {
        labels = Object.assign(defaultLabels, podLabels);
    }

    _.set(podConfig, LABELS_PATH, labels);
}

/**
 * Parses nodeSelector config and update intended nodeSelector in tolerations
 * and nodeAffinity.
 * @param {Object} podConfig      k8s pod config
 * @param {Object} nodeSelectors  key-value pairs of node selectors
 */
function setNodeSelector(podConfig, nodeSelectors) {
    if (!nodeSelectors || typeof nodeSelectors !== 'object' || Object.keys(nodeSelectors).length === 0) {
        return;
    }

    const tolerations = _.get(podConfig, TOLERATIONS_PATH, []);
    const nodeAffinitySelectors = _.get(podConfig, AFFINITY_NODE_SELECTOR_PATH, []);

    Object.keys(nodeSelectors).forEach(key => {
        tolerations.push({
            key,
            value: nodeSelectors[key],
            effect: 'NoSchedule',
            operator: 'Equal'
        });
        nodeAffinitySelectors.push({
            key,
            operator: 'In',
            values: [nodeSelectors[key]]
        });
    });

    const tmpNodeAffinitySelector = {};

    _.set(podConfig, TOLERATIONS_PATH, tolerations);
    _.set(tmpNodeAffinitySelector, AFFINITY_NODE_SELECTOR_PATH, nodeAffinitySelectors);
    _.merge(podConfig, tmpNodeAffinitySelector);
}

/**
 * Parses and update lifecycle hooks config for build container
 * @param {Object} podConfig      k8s pod config
 * @param {Object} lifecycleHooks container lifecycle hooks config
 * @param {String} containerName  name of the build container
 */
function setLifecycleHooks(podConfig, lifecycleHooks, containerName) {
    if (!lifecycleHooks || typeof lifecycleHooks !== 'object' || Object.keys(lifecycleHooks).length === 0) {
        return;
    }

    const buildContainerIndex = _.get(podConfig, 'spec.containers', []).findIndex(c => c.name === containerName);

    if (buildContainerIndex > -1) {
        _.set(podConfig, ['spec', 'containers', buildContainerIndex, 'lifecycle'], _.assign({}, lifecycleHooks));
    }
}

/**
 * Parses preferredNodeSelector config and update intended preferredNodeSelector in nodeAffinity.
 * @param {Object} podConfig              k8s pod config
 * @param {Object} preferredNodeSelectors key-value pairs of preferred node selectors
 */
function setPreferredNodeSelector(podConfig, preferredNodeSelectors) {
    if (
        !preferredNodeSelectors ||
        typeof preferredNodeSelectors !== 'object' ||
        Object.keys(preferredNodeSelectors).length === 0
    ) {
        return;
    }

    const preferredNodeAffinitySelectors = [];
    const preferredNodeAffinityItem = {
        weight: PREFERRED_WEIGHT,
        preference: {}
    };
    const preferredNodeAffinity = _.get(podConfig, AFFINITY_PREFERRED_NODE_SELECTOR_PATH, []);

    Object.keys(preferredNodeSelectors).forEach(key => {
        preferredNodeAffinitySelectors.push({
            key,
            operator: 'In',
            values: [preferredNodeSelectors[key]]
        });
    });

    preferredNodeAffinityItem.preference.matchExpressions = preferredNodeAffinitySelectors;
    preferredNodeAffinity.push(preferredNodeAffinityItem);

    const tmpPreferredNodeAffinitySelector = {};

    _.set(tmpPreferredNodeAffinitySelector, AFFINITY_PREFERRED_NODE_SELECTOR_PATH, preferredNodeAffinity);
    _.merge(podConfig, tmpPreferredNodeAffinitySelector);
}

class K8sExecutor extends Executor {
    /**
     * K8s command to run
     * @method _k8sCommand
     * @param  {Object}      options              An object that tells what command & params to run
     * @param  {Function}    callback             Callback function from K8s API
     */
    _k8sCommand(options, callback) {
        return request(options)
            .then(function cb() {
                // Use "function" (not "arrow function") for getting "arguments"
                callback(null, ...arguments);
            })
            .catch(err => callback(err));
    }

    /**
     * Constructor
     * @method constructor
     * @param  {Object}  options                                                 Configuration options
     * @param  {Object}  options.ecosystem                                       Screwdriver Ecosystem
     * @param  {Object}  options.ecosystem.api                                   Routable URI to Screwdriver API
     * @param  {Object}  [options.ecosystem.pushgatewayUrl]                      Pushgateway URL for Prometheus
     * @param  {Object}  options.ecosystem.store                                 Routable URI to Screwdriver Store
     * @param  {Object}  options.ecosystem.ui                                    Routable URI to Screwdriver UI
     * @param  {Object}  options.kubernetes                                      Kubernetes configuration
     * @param  {String}  [options.kubernetes.token]                              API Token (loaded from /var/run/secrets/kubernetes.io/serviceaccount/token if not provided)
     * @param  {String}  [options.kubernetes.host=kubernetes.default]            Kubernetes hostname
     * @param  {Number}  [options.kubernetes.jobsNamespace=default]              Pods namespace for Screwdriver Jobs
     * @param  {String}  [options.kubernetes.baseImage]                          Base image for the pod
     * @param  {Number}  [options.kubernetes.buildTimeout=90]                    Number of minutes to allow a build to run before considering it is timed out
     * @param  {Number}  [options.kubernetes.maxBuildTimeout=120]                Max timeout user can configure up to
     * @param  {String}  [options.kubernetes.serviceAccount=default]             Service Account for builds
     * @param  {String}  [options.kubernetes.dnsPolicy=ClusterFirst]             DNS Policy for build pod
     * @param  {String}  [options.kubernetes.imagePullPolicy=Always]             Image Pull Policy for build pod
     * @param  {String}  [options.kubernetes.resources.cpu.max=12]               Upper bound for custom CPU value (in cores)
     * @param  {String}  [options.kubernetes.resources.cpu.turbo=12]             Value for TURBO CPU (in cores)
     * @param  {String}  [options.kubernetes.resources.cpu.high=6]               Value for HIGH CPU (in cores)
     * @param  {Number}  [options.kubernetes.resources.cpu.low=2]                Value for LOW CPU (in cores)
     * @param  {Number}  [options.kubernetes.resources.cpu.micro=0.5]            Value for MICRO CPU (in cores)
     * @param  {Number}  [options.kubernetes.resources.memory.max=16]            Value for MAX memory, upper bound for custom memory value (in GB)
     * @param  {Number}  [options.kubernetes.resources.memory.turbo=16]          Value for TURBO memory (in GB)
     * @param  {Number}  [options.kubernetes.resources.memory.high=12]           Value for HIGH memory (in GB)
     * @param  {Number}  [options.kubernetes.resources.memory.low=2]             Value for LOW memory (in GB)
     * @param  {Number}  [options.kubernetes.resources.memory.micro=1]           Value for MICRO memory (in GB)
     * @param  {String}  [options.kubernetes.resources.disk.space]               Value for disk space label (e.g.: screwdriver.cd/disk)
     * @param  {String}  [options.kubernetes.resources.disk.speed]               Value for disk speed label (e.g.: screwdriver.cd/diskSpeed)
     * @param  {Boolean} [options.kubernetes.dockerFeatureEnabled=false]         Whether to enable docker in docker on the executor k8 container
     * @param  {Boolean} [options.kubernetes.privileged=false]                   Privileged mode, default restricted, set to true for DIND use-case
     * @param  {Boolean} [options.kubernetes.automountServiceAccountToken=false] opt-in/out for service account token automount
     * @param  {Object}  [options.kubernetes.podLabels]                          Object representing additional labels to add to a pod
     * @param  {Object}  [options.kubernetes.nodeSelectors]                      Object representing node label-value pairs
     * @param  {Object}  [options.kubernetes.lifecycleHooks]                     Object representing pod lifecycle hooks
     * @param  {Object}  [options.kubernetes.volumeMounts]                       Object representing pod volume mounts (e.g.: [ { "name": "kvm", "mountPath": "/dev/kvm", "path": "/dev/kvm/", "type": "File", "readOnly": true } ] )
     * @param  {String}  [options.kubernetes.terminationGracePeriodSeconds]      TerminationGracePeriodSeconds setting for k8s pods
     * @param  {Number}  [options.kubernetes.podStatusQueryDelay]                Number of milliseconds to wait before calling k8s pod query status for pending retry strategy
     * @param  {String}  [options.kubernetes.runtimeClass='']                    Runtime class
     * @param  {String}  [options.kubernetes.imagePullSecretName='']             Name of image pull secret
     * @param  {String}  [options.launchVersion=stable]                          Launcher container version to use
     * @param  {String}  [options.prefix='']                                     Prefix for job name
     * @param  {String}  [options.fusebox]                                       Options for the circuit breaker (https://github.com/screwdriver-cd/circuit-fuses)
     * @param  {Object}  [options.requestretry]                                  Options for the requestretry (https://github.com/FGRibreau/node-request-retry)
     * @param  {Number}  [options.requestretry.retryDelay]                       Value for retryDelay option of the requestretry
     * @param  {Number}  [options.requestretry.maxAttempts]                      Value for maxAttempts option of the requestretry
     * @param  {String}  [options.ecosystem.cache.strategy='s3']                 Value for build cache - s3, disk
     * @param  {String}  [options.ecosystem.cache.path='']                       Value for build cache path if options.cache.strategy is disk
     * @param  {String}  [options.ecosystem.cache.compress=false]                Value for build cache compress - true / false; used only when cache.strategy is disk
     * @param  {String}  [options.ecosystem.cache.md5check=false]                Value for build cache md5check - true / false; used only when cache.strategy is disk
     * @param  {String}  [options.ecosystem.cache.max_size_mb=0]                 Value for build cache max size in mb; used only when cache.strategy is disk
     * @param  {String}  [options.ecosystem.cache.max_go_threads=10000]          Value for build cache max go threads; used only when cache.strategy is disk
     * @param  {Object}  [options.kubernetes.buildSecrets]                       Object representing secrets (e.g.: [ { "secret_env": "SSHCA", "secret_name": "sd-secret", "secret_key", "private" } ] )
     * @param  {Object}  [options.kubernetes.buildSecretsFile]                   Object representing secrets (e.g.: [ { "name": "kvm", "mountPath": "/dev/kvm", "secretName": "sd-secret", "readOnly": true } ] )
     */
    constructor(options = {}) {
        super();

        this.kubernetes = options.kubernetes || {};
        this.ecosystem = options.ecosystem;
        this.requestretryOptions = options.requestretry || {};
        if (this.kubernetes.token) {
            this.token = this.kubernetes.token;
        } else {
            const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

            this.token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath).toString() : '';
        }
        this.host = this.kubernetes.host || 'kubernetes.default';
        this.runtimeClass = this.kubernetes.runtimeClass || '';
        this.imagePullSecretName = this.kubernetes.imagePullSecretName || '';
        this.launchImage = options.launchImage || 'screwdrivercd/launcher';
        this.launchVersion = options.launchVersion || 'stable';
        this.prefix = options.prefix || '';
        this.jobsNamespace = this.kubernetes.jobsNamespace || 'default';
        this.baseImage = this.kubernetes.baseImage;
        this.buildTimeout = hoek.reach(options, 'kubernetes.buildTimeout') || DEFAULT_BUILD_TIMEOUT;
        this.maxBuildTimeout = this.kubernetes.maxBuildTimeout || MAX_BUILD_TIMEOUT;
        this.serviceAccount = this.kubernetes.serviceAccount || 'default';
        this.dnsPolicy = this.kubernetes.dnsPolicy || 'ClusterFirst';
        this.imagePullPolicy = this.kubernetes.imagePullPolicy || 'Always';
        this.automountServiceAccountToken = this.kubernetes.automountServiceAccountToken === 'true' || false;
        this.terminationGracePeriodSeconds = this.kubernetes.terminationGracePeriodSeconds || 30;
        this.podsUrl = `https://${this.host}/api/v1/namespaces/${this.jobsNamespace}/pods`;
        this.breaker = new Fusebox(this._k8sCommand.bind(this), options.fusebox);
        this.retryDelay = this.requestretryOptions.retryDelay || DEFAULT_RETRYDELAY;
        this.maxAttempts = this.requestretryOptions.maxAttempts || DEFAULT_MAXATTEMPTS;
        this.maxCpu = hoek.reach(options, 'kubernetes.resources.cpu.max', { default: 12 });
        this.turboCpu = hoek.reach(options, 'kubernetes.resources.cpu.turbo', { default: 12 });
        this.highCpu = hoek.reach(options, 'kubernetes.resources.cpu.high', { default: 6 });
        this.lowCpu = hoek.reach(options, 'kubernetes.resources.cpu.low', { default: 2 });
        this.microCpu = hoek.reach(options, 'kubernetes.resources.cpu.micro', { default: 0.5 });
        this.maxMemory = hoek.reach(options, 'kubernetes.resources.memory.max', { default: 16 });
        this.turboMemory = hoek.reach(options, 'kubernetes.resources.memory.turbo', { default: 16 });
        this.highMemory = hoek.reach(options, 'kubernetes.resources.memory.high', { default: 12 });
        this.lowMemory = hoek.reach(options, 'kubernetes.resources.memory.low', { default: 2 });
        this.microMemory = hoek.reach(options, 'kubernetes.resources.memory.micro', { default: 1 });
        this.diskSpeedLabel = hoek.reach(options, 'kubernetes.resources.disk.speed', { default: '' });
        this.podLabels = hoek.reach(options, 'kubernetes.podLabels');
        this.nodeSelectors = hoek.reach(options, 'kubernetes.nodeSelectors');
        this.preferredNodeSelectors = hoek.reach(options, 'kubernetes.preferredNodeSelectors');
        this.lifecycleHooks = hoek.reach(options, 'kubernetes.lifecycleHooks');
        this.volumeMounts = hoek.reach(options, 'kubernetes.volumeMounts', { default: {} });
        this.podStatusQueryDelay = this.kubernetes.podStatusQueryDelay || POD_STATUSQUERY_RETRYDELAY_MS;
        this.cacheStrategy = hoek.reach(options, 'ecosystem.cache.strategy', { default: 's3' });
        this.cachePath = hoek.reach(options, 'ecosystem.cache.path', { default: '/' });
        this.cacheCompress = hoek.reach(options, 'ecosystem.cache.compress', { default: 'false' });
        this.cacheMd5Check = hoek.reach(options, 'ecosystem.cache.md5check', { default: 'false' });
        this.cacheMaxSizeInMB = hoek.reach(options, 'ecosystem.cache.max_size_mb', { default: 0 });
        this.cacheMaxGoThreads = hoek.reach(options, 'ecosystem.cache.max_go_threads', { default: 10000 });
        this.dockerFeatureEnabled = hoek.reach(options, 'kubernetes.dockerFeatureEnabled', { default: false });
        this.annotations = hoek.reach(options, 'kubernetes.annotations');
        this.privileged = hoek.reach(options, 'kubernetes.privileged', { default: false });
        this.secrets = hoek.reach(options, 'kubernetes.buildSecrets', { default: {} });
        this.secretsFile = hoek.reach(options, 'kubernetes.buildSecretsFile', { default: {} });
        this.scheduleStatusRetryStrategy = response => {
            const conditions = hoek.reach(response, 'body.status.conditions');
            let scheduled = false;

            if (conditions) {
                const scheduledStatus = conditions.find(c => c.type === 'PodScheduled').status;

                scheduled = String(scheduledStatus) === 'True';
            }

            if (!scheduled) {
                throw new Error('Retry limit reached');
            }

            return response;
        };
        this.pendingStatusRetryStrategy = response => {
            const status = hoek.reach(response, 'body.status.phase');

            if (!status || status.toLowerCase() === 'pending') {
                throw new Error('Retry limit reached');
            }

            return response;
        };
    }

    /**
     * Update build
     * @method updateBuild
     * @param  {Object}          config                 build config of the job
     * @param  {String}          config.apiUri          screwdriver base api uri
     * @param  {Number}          config.buildId         build id
     * @param  {Object}          [config.stats]         build stats
     * @param  {String}          [config.statusMessage] build status message
     * @param  {String}          config.token           build temporal jwt token
     * @return {Promise}
     */
    updateBuild(config) {
        const { apiUri, buildId, statusMessage, token, stats } = config;
        const options = {
            method: 'PUT',
            url: `${apiUri}/v4/builds/${buildId}`,
            headers: { Authorization: `Bearer ${token}` },
            https: { rejectUnauthorized: false },
            retry: {
                limit: this.maxAttempts,
                calculateDelay: ({ computedValue }) => (computedValue ? this.retryDelay : 0)
            },
            json: {}
        };

        if (statusMessage) {
            options.json.statusMessage = statusMessage;
        }

        if (stats) {
            options.json.stats = stats;
        }

        return this.breaker.runCommand(options);
    }

    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config                A configuration object
     * @param  {Integer}  config.buildId        ID for the build
     * @param  {Integer}  [config.pipeline.id]    pipelineId for the build
     * @param  {Integer}  [config.jobId]          jobId for the build
     * @param  {Integer}  config.eventId        eventId for the build
     * @param  {String}   config.container      Container for the build to run in
     * @param  {String}   config.token          JWT for the Build
     * @param  {String}   [config.jobName]        jobName for the build
     * @return {Promise}  resoves to a boolean value if pod is still pending
     */
    async _start(config) {
        const { buildId, token } = config;
        const podConfig = this.createPodConfig(config);
        const options = {
            url: this.podsUrl,
            method: 'POST',
            json: podConfig,
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            https: { rejectUnauthorized: false }
        };

        try {
            const resp = await this.breaker.runCommand(options);

            if (resp.statusCode !== 201) {
                throw new Error(`Failed to create pod:${JSON.stringify(resp.body)}`);
            }
            const podName = resp.body.metadata.name;
            const { isPending, nodeName } = await this.getPodStatus(podName, buildId);

            const updateConfig = {
                apiUri: this.ecosystem.api,
                buildId,
                token
            };

            if (nodeName) {
                updateConfig.stats = {
                    hostname: nodeName,
                    imagePullStartTime: new Date().toISOString()
                };
            } else {
                updateConfig.statusMessage = 'Waiting for resources to be available.';
            }
            await this.updateBuild(updateConfig);

            return !isPending;
        } catch (err) {
            logger.error(`Failed to run pod for build id:${buildId}: ${err.message}`);
            throw err;
        }
    }

    /**
     *
     * @param {String} podName the pod name
     * @param {String} buildId the build id
     * @returns {Object} the status and node name
     */
    async getPodStatus(podName, buildId) {
        logger.info(`Get pod status for ${podName} and buildId: ${buildId}`);

        const statusOptions = {
            url: `${this.podsUrl}/${podName}/status`,
            method: 'GET',
            headers: { Authorization: `Bearer ${this.token}` },
            https: { rejectUnauthorized: false },
            retry: {
                statusCodes: [200],
                limit: this.maxAttempts,
                calculateDelay: ({ computedValue }) => (computedValue ? this.retryDelay : 0)
            },
            hooks: {
                afterResponse: [this.scheduleStatusRetryStrategy]
            }
        };

        const resp = await this.breaker.runCommand(statusOptions);

        logger.debug(`Build ${buildId} pod response: ${JSON.stringify(resp.body)}`);
        if (resp.statusCode !== 200) {
            throw new Error(`Failed to get pod status:${JSON.stringify(resp.body)}`);
        }

        const nodeName = hoek.reach(resp, 'body.spec.nodeName');
        const responsePodName = hoek.reach(resp, 'body.metadata.name');
        const status = hoek.reach(resp, 'body.status.phase').toLowerCase();

        logger.info(`BuildId:${buildId}, status:${status}, podName:${responsePodName}`);

        if (status === 'failed' || status === 'unknown') {
            throw new Error(`Failed to create pod. Pod status is: ${status}`);
        }

        return { isPending: status === 'pending', nodeName };
    }

    /**
     * creates the pod config
     * @method createPodConfig
     * @param  {Object}   config                A configuration object
     * @param  {Integer}  [config.pipeline.id]    pipelineId for the build
     * @param  {Integer}  [config.jobId]          jobId for the build
     * @param  {Integer}  config.eventId        eventId for the build
     * @param  {String}   config.container      Container for the build to run in
     * @param  {String}   config.token          JWT for the Build
     * @param  {String}   [config.jobName]        jobName for the build
     * @return {Object}   podConfig the pod config object
     */
    createPodConfig(config) {
        const { buildId, eventId, container, token } = config;
        let jobId = hoek.reach(config, 'jobId', { default: '' });
        const pipelineId = hoek.reach(config, 'pipeline.id', { default: '' });
        const jobName = hoek.reach(config, 'jobName', { default: '' });
        const annotations = this.parseAnnotations(hoek.reach(config, 'annotations', { default: {} }));

        const cpuValues = {
            MAX: this.maxCpu,
            TURBO: this.turboCpu,
            HIGH: this.highCpu,
            LOW: this.lowCpu,
            MICRO: this.microCpu
        };

        // for PRs - set pipeline, job cache volume readonly and job cache dir to parent job cache dir
        const matched = PR_JOBNAME_REGEX_PATTERN.exec(jobName);
        let volumeReadOnly = false;

        if (matched && matched.length === 2) {
            const decodedToken = jwt.decode(token, { complete: true });

            volumeReadOnly = true;
            jobId = hoek.reach(decodedToken.payload, 'prParentJobId', { default: jobId });
        }

        const cpuConfig = annotations[CPU_RESOURCE];
        let cpu = cpuConfig in cpuValues ? cpuValues[cpuConfig] * 1000 : cpuValues.LOW * 1000;

        // allow custom cpu value
        if (Number.isInteger(cpuConfig)) {
            cpu = Math.min(cpuConfig, this.maxCpu) * 1000;
        }

        const memValues = {
            TURBO: this.turboMemory,
            HIGH: this.highMemory,
            LOW: this.lowMemory,
            MICRO: this.microMemory
        };
        const memConfig = annotations[RAM_RESOURCE];
        let memory = memConfig in memValues ? memValues[memConfig] : memValues.LOW;

        // allow custom memory value
        if (Number.isInteger(memConfig)) {
            memory = Math.min(memConfig, this.maxMemory);
        }

        const dockerEnabledConfig = annotations[DOCKER_ENABLED_KEY];
        const DOCKER_ENABLED = this.dockerFeatureEnabled && dockerEnabledConfig === true;

        const dockerCpuConfig = annotations[DOCKER_CPU_RESOURCE];
        const DOCKER_CPU = dockerCpuConfig in cpuValues ? cpuValues[dockerCpuConfig] * 1000 : cpuValues.LOW * 1000;

        const dockerMemoryConfig = annotations[DOCKER_MEMORY_RESOURCE];
        const DOCKER_RAM = dockerMemoryConfig in memValues ? memValues[dockerMemoryConfig] : memValues.LOW;

        const random = randomstring.generate({
            length: 5,
            charset: 'alphanumeric',
            capitalization: 'lowercase'
        });
        const buildTimeout = annotations[ANNOTATE_BUILD_TIMEOUT]
            ? Math.min(annotations[ANNOTATE_BUILD_TIMEOUT], this.maxBuildTimeout)
            : this.buildTimeout;

        const templateSourcePath = path.resolve(__dirname, './config/pod.yaml.hbs');

        const source = fs.readFileSync(templateSourcePath, 'utf8');
        const template = handlebars.compile(source);
        let diskCacheEnabled = false;

        if (this.cachePath && this.cacheStrategy === DISK_CACHE_STRATEGY) {
            diskCacheEnabled = true;
            if (this.prefix) {
                this.cachePath = this.cachePath.concat('/').concat(this.prefix);
            }
        }

        const buildContainerName = `${this.prefix}${buildId}`;
        const terminationGracePeriod = annotations[TERMINATION_GRACE_PERIOD_SECONDS]
            ? Math.max(annotations[TERMINATION_GRACE_PERIOD_SECONDS], this.terminationGracePeriodSeconds)
            : this.terminationGracePeriodSeconds;

        const secretsDisabled = this.secrets.length === 1 && Object.keys(this.secrets[0]).length === 0;
        const secretsFileDisabled = this.secretsFile.length === 1 && Object.keys(this.secretsFile[0]).length === 0;

        const podTemplate = template({
            runtimeClass: this.runtimeClass,
            imagePullSecretName: this.imagePullSecretName,
            cpu,
            memory,
            pod_name: `${buildContainerName}-${random}`,
            privileged: this.privileged,
            build_id_with_prefix: buildContainerName,
            prefix: this.prefix,
            build_id: buildId,
            job_id: jobId,
            pipeline_id: pipelineId,
            event_id: eventId,
            build_timeout: buildTimeout,
            container,
            api_uri: this.ecosystem.api,
            store_uri: this.ecosystem.store,
            ui_uri: this.ecosystem.ui,
            pushgateway_url: hoek.reach(this.ecosystem, 'pushgatewayUrl', { default: '' }),
            token,
            launcher_image: `${this.launchImage}:${this.launchVersion}`,
            launcher_version: this.launchVersion,
            base_image: this.baseImage,
            cache: {
                diskEnabled: diskCacheEnabled,
                strategy: this.cacheStrategy,
                path: this.cachePath,
                compress: this.cacheCompress,
                md5check: this.cacheMd5Check,
                max_size_mb: this.cacheMaxSizeInMB,
                max_go_threads: this.cacheMaxGoThreads,
                volumeReadOnly
            },
            service_account: this.serviceAccount,
            automount_service_account_token: this.automountServiceAccountToken,
            termination_grace_period_seconds: terminationGracePeriod,
            docker: {
                enabled: DOCKER_ENABLED,
                cpu: DOCKER_CPU,
                memory: DOCKER_RAM
            },
            dns_policy: this.dnsPolicy,
            image_pull_policy: this.imagePullPolicy,
            volume_mounts: this.volumeMounts,
            secret_entity: {
                disabled: secretsDisabled,
                secrets: this.secrets
            },
            secret_file_entity: {
                disabled: secretsFileDisabled,
                secrets: this.secretsFile
            }
        });
        const podConfig = yaml.safeLoad(podTemplate);
        const nodeSelectors = {};

        if (this.diskSpeedLabel) {
            const diskSpeedConfig = (annotations[DISK_SPEED_RESOURCE] || '').toLowerCase();
            const diskSpeedSelectors = diskSpeedConfig ? { [this.diskSpeedLabel]: diskSpeedConfig } : {};

            hoek.merge(nodeSelectors, diskSpeedSelectors);
        }
        hoek.merge(nodeSelectors, this.nodeSelectors);

        setNodeSelector(podConfig, nodeSelectors);
        setPreferredNodeSelector(podConfig, this.preferredNodeSelectors);
        setAnnotations(podConfig, this.annotations);
        setLabels(podConfig, this.podLabels, buildContainerName);
        setLifecycleHooks(podConfig, this.lifecycleHooks, buildContainerName);

        return podConfig;
    }

    /**
     * Stop a k8s build
     * @method stop
     * @param  {Object}   config            A configuration object
     * @param  {Integer}  config.buildId    ID for the build
     * @return {Promise}
     */
    async _stop(config) {
        const options = {
            url: this.podsUrl,
            method: 'DELETE',
            searchParams: {
                labelSelector: `sdbuild=${this.prefix}${config.buildId}`
            },
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            https: { rejectUnauthorized: false }
        };

        try {
            const resp = await this.breaker.runCommand(options);

            if (resp.statusCode !== 200) {
                throw new Error(`Failed to delete pod:${JSON.stringify(resp.body)}`);
            }

            return null;
        } catch (err) {
            logger.error(`Pod deletion failed for buildId: ${config.buildId} : ${err.message}`);

            throw err;
        }
    }

    /**
     * checks for pod status and waiting reason
     * and returns error message
     * @method verify
     * @param {Object} config
     * @returns {Object} the failure message
     */
    async _verify(config) {
        const { buildId } = config;
        const pods = await this.getPods(buildId);

        logger.info(`Fetched pod list for:${buildId}, count:${pods.length}`);

        let message;
        let waitingReason;

        pods.find(p => {
            const status = hoek.reach(p, 'status.phase').toLowerCase();

            waitingReason = hoek.reach(p, CONTAINER_WAITING_REASON_PATH);

            if (status === 'failed' || status === 'unknown') {
                message = `Failed to create pod. Pod status is: ${status}`;

                return true;
            }

            if (
                ['CrashLoopBackOff', 'CreateContainerConfigError', 'CreateContainerError', 'StartError'].includes(
                    waitingReason
                )
            ) {
                message = 'Build failed to start. Please reach out to your cluster admin for help.';

                return true;
            }

            if (['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'].includes(waitingReason)) {
                message = 'Build failed to start. Please check if your image is valid.';

                return true;
            }

            if (waitingReason === 'PodInitializing') {
                return false;
            }

            return message !== undefined;
        });

        logger.info(`BuildId:${buildId}, status:${message}`);

        if (waitingReason === 'PodInitializing') {
            throw new Error('Build failed to start. Pod is still intializing.');
        }

        return message;
    }

    /**
     *
     * @param {String} buildId the build id
     * @param {String} token the jwt token
     * @returns {Array} array of pods
     */
    async getPods(buildId) {
        logger.info(`Get pod status for and buildId: ${buildId}`);

        const statusOptions = {
            url: this.podsUrl,
            method: 'GET',
            headers: { Authorization: `Bearer ${this.token}` },
            https: { rejectUnauthorized: false },
            retry: {
                statusCodes: [200],
                limit: this.maxAttempts,
                calculateDelay: ({ computedValue }) => (computedValue ? this.retryDelay : 0)
            },
            hooks: {
                afterResponse: [this.pendingStatusRetryStrategy]
            },
            searchParams: {
                labelSelector: `sdbuild=${this.prefix}${buildId}`
            }
        };
        const resp = await this.breaker.runCommand(statusOptions); // list of pods

        logger.debug(`Build ${buildId} pod response: ${JSON.stringify(resp.body)}`);
        if (resp.statusCode !== 200) {
            throw new Error(`Failed to get pod status:${JSON.stringify(resp.body)}`);
        }

        return resp.body.items;
    }

    /**
     * Starts a new periodic build in an executor
     * @method _startPeriodic
     * @return {Promise}  Resolves to null since it's not supported
     */
    _startPeriodic() {
        return Promise.resolve(null);
    }

    /**
     * Stops a new periodic build in an executor
     * @method _stopPeriodic
     * @return {Promise}  Resolves to null since it's not supported
     */
    _stopPeriodic() {
        return Promise.resolve(null);
    }

    /**
     * Starts a new frozen build in an executor
     * @method _startFrozen
     * @return {Promise}  Resolves to null since it's not supported
     */
    _startFrozen() {
        return Promise.resolve(null);
    }

    /**
     * Stops a new frozen build in an executor
     * @method _stopFrozen
     * @return {Promise}  Resolves to null since it's not supported
     */
    _stopFrozen() {
        return Promise.resolve(null);
    }

    /**
     * Retreive stats for the executor
     * @method stats
     * @param  {Response} Object          Object containing stats for the executor
     */
    stats() {
        return this.breaker.stats();
    }
}

module.exports = K8sExecutor;
