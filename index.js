'use strict';
const Executor = require('screwdriver-executor-base');
const path = require('path');
const Readable = require('stream').Readable;
const Fusebox = require('circuit-fuses');
const request = require('request');
const tinytim = require('tinytim');
const yaml = require('js-yaml');
const hoek = require('hoek');
const SCM_URL_REGEX = /^git@([^:]+):([^\/]+)\/(.+?)\.git(#.+)?$/;
const GIT_ORG = 2;
const GIT_REPO = 3;
const GIT_BRANCH = 4;

class K8sExecutor extends Executor {

    /**
     * Constructor
     * @method constructor
     * @param  {Object} options           Configuration options
     * @param  {Object} options.token     Api Token to make requests with
     * @param  {Object} options.host      Kubernetes hostname to make requests to
     */
    constructor(options) {
        super();

        this.token = options.token;
        this.host = options.host;
        this.jobsUrl = `https://${this.host}/apis/batch/v1/namespaces/default/jobs`;
        this.podsUrl = `https://${this.host}/api/v1/namespaces/default/pods`;
        this.breaker = new Fusebox(request);
    }

    /**
     * Starts a k8s build
     * @method start
     * @param  {Object}   config            A configuration object
     * @param  {String}   config.buildId    ID for the build
     * @param  {String}   config.jobId      ID for the job
     * @param  {String}   config.pipelineId ID for the pipeline
     * @param  {String}   config.container  Container for the build to run in
     * @param  {String}   config.scmUrl     Scm URL to use in the build
     * @param  {Function} callback          Callback function
     */
    _start(config, callback) {
        const scmMatch = SCM_URL_REGEX.exec(config.scmUrl);
        const jobTemplate = tinytim.renderFile(path.resolve(__dirname, './config/job.yaml.tim'), {
            git_org: scmMatch[GIT_ORG],
            git_repo: scmMatch[GIT_REPO],
            git_branch: (scmMatch[GIT_BRANCH] || '#master').slice(1),
            job_name: 'main',
            build_id: config.buildId,
            job_id: config.jobId,
            pipeline_id: config.pipelineId
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
    * Streams logs
    * @method stream
    * @param  {Object}   config            A configuration object
    * @param  {String}   config.buildId    ID for the build
    * @param  {Response} callback          Callback for when a stream is created
    */
    _stream(config, callback) {
        const pod = `${this.podsUrl}?labelSelector=sdbuild=${config.buildId}`;
        const options = {
            url: pod,
            headers: {
                Authorization: `Bearer ${this.token}`
            },
            json: true,
            strictSSL: false
        };

        this.breaker.runCommand(options, (err, resp) => {
            if (err) {
                return callback(new Error(`Error getting pod with sdbuild=${config.buildId}`));
            }

            const body = resp.body;
            const podName = hoek.reach(body, 'items.0.metadata.name');

            if (!podName) {
                return callback(new Error(`Error getting pod name: ${JSON.stringify(body)}`));
            }
            const logUrl = `${this.podsUrl}/${podName}/log?container=build&follow=true&pretty=true`;

            return callback(null, new Readable().wrap(request.get({
                url: logUrl,
                headers: {
                    Authorization: `Bearer ${this.token}`
                },
                strictSSL: false
            })));
        });
    }
}

module.exports = K8sExecutor;
