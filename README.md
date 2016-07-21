# Screwdriver Kubernetes Executor
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][wercker-image]][wercker-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> Kubernetes Executor plugin for Screwdriver

This executor plugin extends the [executor-base-class], and provides methods to start jobs and stream logs
from Kubernetes

## Usage

```bash
npm install screwdriver-executor-k8s
```

### Configure
The class provides a couple options that are configurable in the instantiation of this Executor

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.token | String | The JWT token used for authenticating to the kubernetes cluster |
| config.host | String | The hostname for the kubernetes cluster i.e. `kubernetes` if running inside kubernetes |

### Start
The `_start` method takes advantage of the input validation defined in the [executor-base-class].

The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.buildId | String | The unique ID for a build |
| config.jobId | String | The unique ID for a job |
| config.pipelineId | String | The unique ID for a pipeline |
| config.container | String | Container for the build to run in |
| config.scmUrl | String | The scmUrl to checkout |
| callback | Function | Callback `fn(err)` for when job has been created |

The `_start` function will start a job in kubernetes with labels for easy lookup. These labels are:
* sdbuild: config.buildId
* sdjob: config.jobId
* sdpipeline: config.pipelineId

The job runs two containers:
* Runs the [screwdriver job-tools] container, sharing the files in `/opt/screwdriver`
* Runs the specified container (As of 7/21, only runs `node:4`), which runs `/opt/screwdriver/launch` with the required parameters

The callback is called with:
* An error `callback(err)` when an error occurs starting the job
* null `callback(null)` when a job is correctly started

### Stream
The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.buildId | String | The unique ID for a build to stream logs for|
| callback | Function | Callback `fn(err, stream)` for when stream has been created |

The `_stream` function will call back with a Readable stream if a job exists with the `buildId` tag

The callback is called with:
* An error `callback(err)` when an error occurs fetching the logs
* The stream `callback(null, readableStream)` when a stream is opened up for reading logs

## Testing

```bash
npm test
```

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-executor-k8s.svg
[npm-url]: https://npmjs.org/package/screwdriver-executor-k8s
[downloads-image]: https://img.shields.io/npm/dt/screwdriver-executor-k8s.svg
[license-image]: https://img.shields.io/npm/l/screwdriver-executor-k8s.svg
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/executor-k8s.svg
[issues-url]: https://github.com/screwdriver-cd/executor-k8s/issues
[wercker-image]: https://app.wercker.com/status/6eee5facca93cb34510bf36d814460e8
[wercker-url]: https://app.wercker.com/project/bykey/6eee5facca93cb34510bf36d814460e8
[daviddm-image]: https://david-dm.org/screwdriver-cd/executor-k8s.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/executor-k8s
[executor-base-class]: https://github.com/screwdriver-cd/executor-base
[screwdriver job-tools]: https://github.com/screwdriver-cd/job-tools
