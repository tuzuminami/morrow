# Release Evidence

MORROW releases only when a newly pushed semver tag points to a green `main`
commit. The **Release evidence** workflow verifies the tag, runs the full
repository gate, checks production dependency advisories, builds the package,
and creates a CycloneDX SBOM.

The workflow publishes exactly these assets with the GitHub Release:

- the npm package tarball;
- `morrow.cdx.json`, the CycloneDX SBOM for that package; and
- `SHA256SUMS`, covering both files.

Before release publication, GitHub Actions creates separate signed build
provenance and SBOM attestations for the package tarball. The untrusted build
job has read-only repository access; a separate publication job receives only
the generated evidence and holds the write permissions.

The workflow never mutates an existing published release. V1.0.0 predates this
control and has no release evidence; a later corrective release is required to
provide attested assets. A pre-existing empty draft can resume safely, but any
draft or release with assets stops the workflow instead of mixing evidence.

## Maintainer Procedure

1. Merge a reviewed change through the protected `main` branch and wait for
   `verify` to pass.
2. Create and push an annotated semver tag whose version equals `package.json`.
3. Push the tag. **Release evidence** starts from the tag event so its signed
   provenance is bound to the released source revision.
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
