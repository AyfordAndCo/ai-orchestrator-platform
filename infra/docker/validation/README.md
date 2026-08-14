# Validation image

Build and publish this image to Docker Hub from the manual
`Publish validation image` GitHub Actions workflow (configure
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets). Pin the
published image by digest in worker configuration; do not use a mutable tag in
production.

The image contains only the Node/pnpm runtime. The repository workspace and
its already-provisioned dependencies are mounted at `/workspace` when a
validation run starts.

Example:

```sh
docker build \
  --build-arg PNPM_VERSION=11.19.0 \
  -t docker.io/example/orchestrator-validation:pnpm-11.19.0 \
  -f infra/docker/validation/Dockerfile \
  .
docker push docker.io/example/orchestrator-validation:pnpm-11.19.0
docker image inspect \
  docker.io/example/orchestrator-validation:pnpm-11.19.0 \
  --format '{{index .RepoDigests 0}}'
```
