# Verstas

## Versioning

Every commit that changes what Verstas does (a feature, a fix, a
behaviour change in the host app, the worker, the proxy or the web UI)
bumps Verstas's minor version in the same commit:

```bash
npm version minor --no-git-tag-version
```

That updates `package.json` and `package-lock.json`; stage both with the
change. Do it once per commit, not per file. Docs-only and test-only
commits do not bump. Do not create git tags.
