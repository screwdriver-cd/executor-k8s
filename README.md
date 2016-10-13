# Screwdriver Kubernetes Executor
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> Kubernetes Executor plugin for Screwdriver

This is an executor for the Screwdriver CD solution that interacts with Kubernetes.

## Usage

```bash
npm install screwdriver-executor-k8s
```

### Initialization
The class provides a couple options that are configurable in the instantiation of this Executor

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.token | String | The JWT token used for authenticating to the Kubernetes cluster (content of `/var/run/secrets/kubernetes.io/serviceaccount/token`) |
| config.host | String | The hostname for the Kubernetes cluster (kubernetes) |
| config.toolsVersion | String | Job Tools container version to use (stable) |
| config.logVersion | String | Log Service container version to use (stable) |


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
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/executor-k8s.svg
[issues-url]: https://github.com/screwdriver-cd/executor-k8s/issues
[status-image]: https://cd.screwdriver.cd/pipelines/93e9490017956488ed8f5d185645127a95e1914c/badge
[status-url]: https://cd.screwdriver.cd/pipelines/93e9490017956488ed8f5d185645127a95e1914c
[daviddm-image]: https://david-dm.org/screwdriver-cd/executor-k8s.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/executor-k8s
[executor-base-class]: https://github.com/screwdriver-cd/executor-base
[screwdriver job-tools]: https://github.com/screwdriver-cd/job-tools
