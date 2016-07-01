'use strict';
const Executor = require('screwdriver-executor-base');
const fs = require('fs');
const path = require('path');
const request = require('request');
const tinytim = require('tinytim');
const yaml = require('js-yaml');
const hoek = require('hoek');
const API_KEY = process.env.K8S_TOKEN || fs.readFileSync('/etc/kubernetes/apikey/token', 'utf-8');
const SCM_URL_REGEX = /^git@([^:]+):([^\/]+)\/(.+?)\.git(#.+)?$/;
const GIT_ORG = 2;
const GIT_REPO = 3;
const GIT_BRANCH = 4;
const k8sCluster = process.env.K8S_HOST || 'kubernetes';
const jobsUrl = `https://${k8sCluster}/apis/batch/v1/namespaces/default/jobs`;
const podsUrl = `https://${k8sCluster}/api/v1/namespaces/default/pods`;

class K8sExecutor extends Executor {
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
    start(config, callback) {
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
            json: yaml.safeLoad(jobTemplate),
            headers: {
                Authorization: `Bearer ${API_KEY}`
            },
            strictSSL: false
        };

        request.post(jobsUrl, options, (err, resp, body) => {
            if (err) {
                return callback(err);
            }

            if (resp.statusCode !== 201) {
                const msg = `Failed to create job: ${JSON.stringify(body)}`;

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
    * @param  {Response} response          Response object to stream logs
    */
    stream(config, response) {
        const pod = `${podsUrl}?labelSelector=sdbuild=${config.buildId}`;
        const options = {
            url: pod,
            headers: {
                Authorization: `Bearer ${API_KEY}`
            },
            json: true,
            strictSSL: false
        };

        request.get(options, (err, resp, body) => {
            if (err) {
                return response(new Error(`Error getting pod with sdbuild=${config.buildId}`));
            }
            const podName = hoek.reach(body, 'items.0.metadata.name');

            if (!podName) {
                return response(new Error(`Error getting pod name: ${JSON.stringify(body)}`));
            }
            const logUrl = `${podsUrl}/${podName}/log?container=build&follow=true&pretty=true`;

            return request.get({
                url: logUrl,
                headers: {
                    Authorization: `Bearer ${API_KEY}`
                },
                strictSSL: false
            }).pipe(response);
        });
    }
}

module.exports = K8sExecutor;
