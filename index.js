'use strict';

const Executor = require('screwdriver-executor-base');
const path = require('path');
const Fusebox = require('circuit-fuses');
const request = require('request');
const tinytim = require('tinytim');
const yaml = require('js-yaml');
const fs = require('fs');
const hoek = require('hoek');

const CPU_RESOURCE = 'beta.screwdriver.cd/cpu';
const RAM_RESOURCE = 'beta.screwdriver.cd/ram';

class K8sExecutor extends Executor {
    /**
     * Constructor
     * @method constructor
     * @param  {Object} options                                      Configuration options
     * @param  {Object} options.ecosystem                            Screwdriver Ecosystem
     * @param  {Object} options.ecosystem.api                        Routable URI to Screwdriver API
     * @param  {Object} options.ecosystem.store                      Routable URI to Screwdriver Store
     * @param  {Object} options.kubernetes                           Kubernetes configuration
     * @param  {String} [options.kubernetes.token]                   API Token (loaded from /var/run/secrets/kubernetes.io/serviceaccount/token if not provided)
     * @param  {String} [options.kubernetes.host=kubernetes.default] Kubernetes hostname
     * @param  {String} [options.kubernetes.serviceAccount=default]  Service Account for builds
     * @param  {String} [options.kubernetes.jobsNamespace=default]   Pods namespace for Screwdriver Jobs
     * @param  {String} [options.launchVersion=stable]               Launcher container version to use
     * @param  {String} [options.prefix='']                          Prefix for job name
     * @param  {String} [options.fusebox]                            Options for the circuit breaker (https://github.com/screwdriver-cd/circuit-fuses)
     */
    constructor(options = {}) {
        super();

        this.kubernetes = options.kubernetes || {};
        this.ecosystem = options.ecosystem;
        if (this.kubernetes.token) {
            this.token = this.kubernetes.token;
        } else {
            const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

            this.token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath).toString() : '';
        }
        this.host = this.kubernetes.host || 'kubernetes.default';
        this.launchVersion = options.launchVersion || 'stable';
        this.prefix = options.prefix || '';
        this.serviceAccount = this.kubernetes.serviceAccount || 'default';
        this.jobsNamespace = this.kubernetes.jobsNamespace || 'default';
        this.podsUrl = `https://${this.host}/api/v1/namespaces/${this.jobsNamespace}/pods`;
        this.breaker = new Fusebox(request, options.fusebox);
    }

    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config            A configuration object
     * @param  {Integer}  config.buildId    ID for the build
     * @param  {String}   config.container  Container for the build to run in
     * @param  {String}   config.token      JWT for the Build
     * @return {Promise}
     */
    _start(config) {
        const cpuConfig = hoek.reach(config, 'annotations', { default: {} })[CPU_RESOURCE];
        const ramConfig = hoek.reach(config, 'annotations', { default: {} })[RAM_RESOURCE];
        const CPU = (cpuConfig === 'HIGH') ? 6000 : 2000; // 6000 millicpu or 2000 millicpu
        const MEMORY = (ramConfig === 'HIGH') ? 12 : 2;   // 12GB or 2GB
        const podTemplate = tinytim.renderFile(path.resolve(__dirname, './config/pod.yaml.tim'), {
            build_id_with_prefix: `${this.prefix}${config.buildId}`,
            build_id: config.buildId,
            container: config.container,
            api_uri: this.ecosystem.api,
            store_uri: this.ecosystem.store,
            token: config.token,
            launcher_version: this.launchVersion,
            service_account: this.serviceAccount,
            cpu: CPU,
            memory: MEMORY
        });

        const options = {
            uri: this.podsUrl,
            method: 'POST',
            json: yaml.safeLoad(podTemplate),
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            strictSSL: false
        };

        return this.breaker.runCommand(options)
            .then((resp) => {
                if (resp.statusCode !== 201) {
                    throw new Error(`Failed to create pod: ${JSON.stringify(resp.body)}`);
                }

                return null;
            });
    }

    /**
     * Stop a k8s build
     * @method stop
     * @param  {Object}   config            A configuration object
     * @param  {Integer}  config.buildId    ID for the build
     * @return {Promise}
     */
    _stop(config) {
        const options = {
            uri: this.podsUrl,
            method: 'DELETE',
            qs: {
                labelSelector: `sdbuild=${this.prefix}${config.buildId}`
            },
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            strictSSL: false
        };

        return this.breaker.runCommand(options)
            .then((resp) => {
                if (resp.statusCode !== 200) {
                    throw new Error(`Failed to delete pod: ${JSON.stringify(resp.body)}`);
                }

                return null;
            });
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
