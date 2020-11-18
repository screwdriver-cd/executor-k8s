# Screwdriver Kubernetes Executor
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> Kubernetes Executor plugin for Screwdriver

This is an executor for the Screwdriver continuous delivery solution that interacts with Kubernetes.

## Usage

```bash
npm install screwdriver-executor-k8s
```

### Initialization
The class provides a couple options that are configurable in the instantiation of this Executor

| Parameter        | Type  | Default    | Description |
| :-------------   | :---- | :----------| :-----------|
| config        | Object | | Configuration Object |
| config.kubernetes | Object | {} | Kubernetes configuration Object |
| config.kubernetes.token | String | '' | The JWT token used for authenticating to the Kubernetes cluster. (If not passed in, we will read from `/var/run/secrets/kubernetes.io/serviceaccount/token`.) |
| config.kubernetes.host | String | 'kubernetes.defaults' | The hostname for the Kubernetes cluster (kubernetes) |
| config.kubernetes.serviceAccount | String | 'default' | The service account to use in Kubernetes (default) |
| config.ecosystem | Object | | Screwdriver Ecosystem (ui, api, store, etc.) |
| config.launchImage | String | 'screwdrivercd/launcher' | Launcher image to use |
| config.launchVersion | String | 'stable' | Launcher container version to use (stable) |
| config.prefix | String | '' | Prefix to container names ("") |
| config.kubernetes.jobsNamespace | String | 'default' | Kubernetes namespace where builds are running on |
| config.kubernetes.resources.memory.turbo | Number | 16 | Value for TURBO memory (in GB) |
| config.kubernetes.resources.memory.high | Number | 12 | Value for HIGH memory (in GB) |
| config.kubernetes.resources.memory.low | Number | 2 | Value for LOW memory (in GB) |
| config.kubernetes.resources.memory.micro | Number | 1 | Value for MICRO memory (in GB) |
| config.kubernetes.resources.cpu.turbo | Number | 12 | Value for TURBO CPU (in cores) |
| config.kubernetes.resources.cpu.high | Number | 6 | Value for HIGH CPU (in cores) |
| config.kubernetes.resources.cpu.low | Number | 2 | Value for LOW CPU (in cores) |
| config.kubernetes.resources.cpu.micro | Number | 0.5 | Value for MICRO CPU (in cores) |


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
