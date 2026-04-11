import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuditTransportFailure, summarizeAuditVulnerabilities } from '../../scripts/publish-check.mjs';

test('isAuditTransportFailure detects transient npm audit network failures', () => {
  assert.equal(
    isAuditTransportFailure('npm warn audit request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: Client network socket disconnected before secure TLS connection was established'),
    true
  );
  assert.equal(isAuditTransportFailure('found 0 vulnerabilities'), false);
});

test('summarizeAuditVulnerabilities reads metadata total when available', () => {
  assert.equal(summarizeAuditVulnerabilities({
    metadata: {
      vulnerabilities: {
        total: 3
      }
    }
  }), 3);
});

test('summarizeAuditVulnerabilities falls back to vulnerability entry count', () => {
  assert.equal(summarizeAuditVulnerabilities({
    vulnerabilities: {
      axios: {},
      minimist: {}
    }
  }), 2);
});
