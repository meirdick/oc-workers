import { describe, expect, it } from "vitest";
import { dbRelpathsFromKeys, signV4 } from "../lib/s3.mjs";

const KEY = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

describe("signV4", () => {
  // AWS SigV4 test suite: get-vanilla.
  it("get-vanilla", () => {
    const h = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      ...KEY,
      now: new Date("2015-08-30T12:36:00Z"),
      s3: false,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
  // AWS SigV4 test suite: get-vanilla-query-order-key-case.
  it("sorts query keys", () => {
    const h = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      region: "us-east-1",
      service: "service",
      ...KEY,
      now: new Date("2015-08-30T12:36:00Z"),
      s3: false,
    });
    expect(h.authorization).toMatch(
      /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/,
    );
  });
  // S3 docs example: GET object with Range (sig v4 header auth).
  it("s3 get object example", () => {
    const h = signV4({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      headers: { Range: "bytes=0-9" },
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("dbRelpathsFromKeys", () => {
  it("maps Litestream LTX keys to DB relpaths", () => {
    const p = "r/m0/g2/";
    const keys = [
      "r/m0/g2/state/openclaw.sqlite/0000/0000000000000001-0000000000000001.ltx",
      "r/m0/g2/state/openclaw.sqlite/0001/0000000000000001-0000000000000003.ltx",
      "r/m0/g2/agents/main/agent/openclaw-agent.sqlite/0009/0000000000000001-0000000000000001.ltx",
      "r/m0/g20/state/openclaw.sqlite/0000/0000000000000001-0000000000000001.ltx",
      "r/m0/g2/stray-object",
    ];
    expect(dbRelpathsFromKeys(keys, p)).toEqual([
      "agents/main/agent/openclaw-agent.sqlite",
      "state/openclaw.sqlite",
    ]);
  });
});
