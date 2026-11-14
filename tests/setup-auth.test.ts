import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidSetupKey, setupKeyFromHeaders } from "../src/setup-auth.js";

test("reads the setup key from Authorization: Bearer or X-Setup-Key", () => {
  assert.equal(setupKeyFromHeaders(new Headers({ authorization: "Bearer s3cret" })), "s3cret");
  assert.equal(setupKeyFromHeaders(new Headers({ authorization: "bearer  s3cret " })), "s3cret");
  assert.equal(setupKeyFromHeaders(new Headers({ "x-setup-key": "s3cret" })), "s3cret");
  assert.equal(setupKeyFromHeaders(new Headers({ authorization: "Basic abc" })), null);
  assert.equal(setupKeyFromHeaders(new Headers()), null);
});

test("compares keys exactly", () => {
  assert.equal(isValidSetupKey("s3cret", "s3cret"), true);
  assert.equal(isValidSetupKey("s3cre", "s3cret"), false);
  assert.equal(isValidSetupKey("S3CRET", "s3cret"), false);
  assert.equal(isValidSetupKey(null, "s3cret"), false);
  assert.equal(isValidSetupKey("", ""), false);
});
