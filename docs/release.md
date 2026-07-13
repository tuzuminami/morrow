# Release Evidence

MORROW releases only from an existing semver tag that points to a green `main`
commit. The **Release evidence** workflow verifies the tag, runs the full
repository gate, checks production dependency advisories, builds the package,
and creates a CycloneDX SBOM.

The workflow publishes exactly these assets with the GitHub Release:

- the npm package tarball;
- `morrow.cdx.json`, the CycloneDX SBOM for that package; and
- `SHA256SUMS`, covering both files.

Before release publication, GitHub Actions creates a signed provenance and SBOM
attestation for the package tarball. Releases are intentionally created only
when no release exists for the tag; evidence is never overwritten.

## Maintainer Procedure

1. Merge a reviewed change through the protected `main` branch and wait for
   `verify` to pass.
2. Create and push an annotated semver tag whose version equals `package.json`.
3. Run **Release evidence** from GitHub Actions and provide that tag.
4. Confirm the generated release contains the tarball, SBOM, and checksums.
5. Verify the release artifact before announcing it:

   ```bash
   gh release download v1.0.1 --repo tuzuminami/morrow --pattern '*.tgz'
   gh attestation verify tuzuminami-morrow-1.0.1.tgz --repo tuzuminami/morrow
   gh attestation verify tuzuminami-morrow-1.0.1.tgz \
     --repo tuzuminami/morrow \
     --predicate-type https://cyclonedx.org/bom
   ```

Use a corrective patch release for any release problem. Do not move a public
tag or overwrite an existing release asset.

## Dependency Updates

Dependabot opens weekly PRs for npm dependencies and GitHub Actions. Every PR
runs the same protected `verify` check as product changes. Action references
are pinned to immutable commit SHAs; update their SHA and the adjacent version
comment together.
