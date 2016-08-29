# Screwdriver Kubernetes Executor
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][wercker-image]][wercker-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> Kubernetes Executor plugin for Screwdriver

This executor plugin extends the [executor-base-class], and provides methods to start and stop jobs
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
| config.token | String | The JWT token used for authenticating to the Kubernetes cluster |
| config.host | String | The hostname for the Kubernetes cluster i.e. `Kubernetes` if running inside Kubernetes |
| config.toolsVersion | String | Job Tools container version to use (latest) |
| config.logVersion | String | Log Service container version to use (latest) |

### Start
The `start` method takes advantage of the input validation defined in the [executor-base-class].

The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.buildId | String | The unique ID for a build |
| config.container | String | Container for the build to run in |
| config.apiUri | String | Screwdriver's API |
| config.token | String | JWT to act on behalf of the build |
| callback | Function | Callback for when task has been created |

The `start` function will start a job in Kubernetes with labels for easy lookup. These labels are:
* sdbuild: config.buildId

The job runs two containers:
* Runs the [screwdriver job-tools] container, sharing the files in `/opt/screwdriver`
* Runs the specified container, which runs `/opt/screwdriver/launch` with the required parameters

The callback is called with:
* An error `callback(err)` when an error occurs starting the job
* null `callback(null)` when a job is correctly started

### Stop
The `stop` method takes advantage of the input validation defined in the [executor-base-class].

The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.buildId | String | The unique ID for a build |
| callback | Function | Callback for when the job has been stopped |

The `stop` function will stop a job in Kubernetes using a label:
* sdbuild: config.buildId

The callback is called with:
* An error `callback(err)` when an error occurs stopping the job
* null `callback(null)` when a job is correctly stopped

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
