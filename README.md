# Screwdriver Kubernetes Executor
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> Kubernetes Executor plugin for Screwdriver

This is an executor for the Screwdriver continous delivery solution that interacts with Kubernetes.

## Usage

```bash
npm install screwdriver-executor-k8s
```

### Initialization
The class provides a couple options that are configurable in the instantiation of this Executor

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.kubernetes | Object | Kubernetes configuration Object |
| config.kubernetes.token | String | The JWT token used for authenticating to the Kubernetes cluster (content of `/var/run/secrets/kubernetes.io/serviceaccount/token`) |
| config.kubernetes.host | String | The hostname for the Kubernetes cluster (kubernetes) |
| config.kubernetes.serviceAccount | String | The service account to use in Kubernetes (default) |
| config.ecosystem | Object | Screwdriver Ecosystem (ui, api, store, etc.) |
| config.launchVersion | String | Launcher container version to use (stable) |
| config.prefix | String | Prefix to container names ("") |


### Methods

For more information on `start`, `stop`, and `stats` please see the [executor-base-class].

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
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/screwdriver.svg
[issues-url]: https://github.com/screwdriver-cd/screwdriver/issues
[status-image]: https://cd.screwdriver.cd/pipelines/28/badge
[status-url]: https://cd.screwdriver.cd/pipelines/28
[daviddm-image]: https://david-dm.org/screwdriver-cd/executor-k8s.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/executor-k8s
[executor-base-class]: https://github.com/screwdriver-cd/executor-base
[screwdriver job-tools]: https://github.com/screwdriver-cd/job-tools
