'use strict';
const Executor = require('screwdriver-executor-base');
const path = require('path');
const Fusebox = require('circuit-fuses');
const request = require('request');
const tinytim = require('tinytim');
const yaml = require('js-yaml');

class K8sExecutor extends Executor {

    /**
     * Constructor
     * @method constructor
     * @param  {Object} options                Configuration options
     * @param  {String} options.token          Api Token to make requests with
     * @param  {String} options.host           Kubernetes hostname to make requests to
     * @param  {String} [options.toolsVersion] Job Tools container version to use (latest)
     * @param  {String} [options.logVersion]   Log Service container version to use (latest)
     */
    constructor(options) {
        super();

        this.token = options.token;
        this.host = options.host;
        this.toolsVersion = options.toolsVersion || 'latest';
        this.logVersion = options.logVersion || 'latest';
        this.jobsUrl = `https://${this.host}/apis/batch/v1/namespaces/default/jobs`;
        this.podsUrl = `https://${this.host}/api/v1/namespaces/default/pods`;
        this.breaker = new Fusebox(request);
    }

    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config            A configuration object
     * @param  {String}   config.buildId    ID for the build
     * @param  {String}   config.container  Container for the build to run in
     * @param  {String}   config.apiUri     API Uri
     * @param  {String}   config.token      JWT for the Build
     * @param  {Function} callback          Callback function
     */
    _start(config, callback) {
        const jobTemplate = tinytim.renderFile(path.resolve(__dirname, './config/job.yaml.tim'), {
            build_id: config.buildId,
            container: config.container,
            api_uri: config.apiUri,
            token: config.token,
            tools_version: this.toolsVersion,
            log_version: this.logVersion
        });

        const options = {
            uri: this.jobsUrl,
            method: 'POST',
            json: yaml.safeLoad(jobTemplate),
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            strictSSL: false
        };

        this.breaker.runCommand(options, (err, resp) => {
            if (err) {
                return callback(err);
            }

            if (resp.statusCode !== 201) {
                const msg = `Failed to create job: ${JSON.stringify(resp.body)}`;

                return callback(new Error(msg));
            }

            return callback(null);
        });
    }

    /**
     * Stop a k8s build
     * @method stop
     * @param  {Object}   config            A configuration object
     * @param  {String}   config.buildId    ID for the build
     * @param  {Function} callback          Callback function
     */
    _stop(config, callback) {
        const options = {
            uri: this.jobsUrl,
            method: 'DELETE',
            qs: {
                labelSelector: `sdbuild=${config.buildId}`
            },
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            strictSSL: false
        };

        // @TODO collect logs before removing all traces of it.
        this.breaker.runCommand(options, (err, resp) => {
            if (err) {
                return callback(err);
            }

            if (resp.statusCode !== 200) {
                const msg = `Failed to delete job: ${JSON.stringify(resp.body)}`;

                return callback(new Error(msg));
            }

            return callback(null);
        });
    }

    /**
    * Retreive stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return {
            requests: {
                total: this.breaker.getTotalRequests(),
                timeouts: this.breaker.getTimeouts(),
                success: this.breaker.getSuccessfulRequests(),
                failure: this.breaker.getFailedRequests(),
                concurrent: this.breaker.getConcurrentRequests(),
                averageTime: this.breaker.getAverageRequestTime()
            },
            breaker: {
                isClosed: this.breaker.isClosed()
            }
        };
    }
}

module.exports = K8sExecutor;
