# Runbook: key rotation

## Access-token signing key (identity-service)

1. Generate a new ES256 JWK with a new `kid`.
2. Deploy identity-service with:
   - `ACCESS_TOKEN_SIGNING_KEY` set to the new key;
   - `ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY` set to the old public key.

   The JWKS now publishes both keys.

3. Wait at least `ACCESS_TOKEN_TTL_SECONDS` plus the JWKS cache cooldown (30 s). Then remove `ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY`.

## Service token keys

1. Generate a new key pair for service X.
2. Add the new public key as an additional trusted key in every callee of X. Callees accept a key list during rotation.
3. Switch X's `SERVICE_PRIVATE_KEY`.
4. Remove the old public key from the callees.

During rotation, the old and new keys are both trusted.

## MFA encryption key

This is a planned operational job. Decrypt every TOTP secret with the old key and re-encrypt it with the new one in a single maintenance task, with a backup taken first. Until the job exists, treat the key as long-lived and protect it with KMS.

## OTP pepper

Rotate with a rolling restart. Outstanding codes (5-minute lifetime) become invalid, and users request a new code.
