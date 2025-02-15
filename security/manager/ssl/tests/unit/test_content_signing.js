/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// These tests ensure content signatures are working correctly.

// First, we need to set up some data
const PREF_SIGNATURE_ROOT = "security.content.signature.root_hash";

const TEST_DATA_DIR = "test_content_signing/";

function getSignatureVerifier() {
  return Cc["@mozilla.org/security/contentsignatureverifier;1"]
           .createInstance(Ci.nsIContentSignatureVerifier);
}

function setRoot(filename) {
  let cert = constructCertFromFile(filename);
  Services.prefs.setCharPref(PREF_SIGNATURE_ROOT, cert.sha256Fingerprint);
}

function loadChain(prefix, names) {
  let chain = [];
  for (let name of names) {
    let filename = `${prefix}_${name}.pem`;
    chain.push(readFile(do_get_file(filename)));
  }
  return chain;
}

function run_test() {
  // set up some data
  const DATA = readFile(do_get_file(TEST_DATA_DIR + 'test.txt'));
  const GOOD_SIGNATURE = "p384ecdsa=" +
      readFile(do_get_file(TEST_DATA_DIR + 'test.txt.signature'))
      .trim();

  const BAD_SIGNATURE = "p384ecdsa=WqRXFQ7tnlVufpg7A-ZavXvWd2Zln0o4woHBy26C2r" +
                        "UWM4GJke4pE8ecHiXoi-7KnZXty6Pe3s4o3yAIyKDP9jUC52Ek1G" +
                        "q25j_X703nP5rk5gM1qz5Fe-qCWakPPl6L";

  setRoot(TEST_DATA_DIR + "content_signing_root.pem");

  let remoteNewTabChain = loadChain(TEST_DATA_DIR + "content_signing",
                                    ["remote_newtab_ee", "int", "root"]);

  let oneCRLChain = loadChain(TEST_DATA_DIR + "content_signing",
                              ["onecrl_ee", "int", "root"]);

  let oneCRLBadKeyChain = loadChain(TEST_DATA_DIR + "content_signing",
                                    ["onecrl_wrong_key_ee", "int", "root"]);

  let oneCRLRSAKeyChain = loadChain(TEST_DATA_DIR + "content_signing",
                                    ["onecrl_RSA_ee", "int", "root"]);

  // Check good signatures from good certificates with the correct SAN
  let chain1 = oneCRLChain.join("\n");
  let verifier = getSignatureVerifier();
  ok(verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, chain1,
                                     verifier.ONECRL),
     "A OneCRL signature should verify with the OneCRL chain");
  let chain2 = remoteNewTabChain.join("\n");
  verifier = getSignatureVerifier();
  ok(verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, chain2,
                                     verifier.ABOUT_NEWTAB),
     "A newtab signature should verify with the newtab chain");

  // Check a bad signature when a good chain is provided
  chain1 = oneCRLChain.join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, BAD_SIGNATURE, chain1,
                                      verifier.ONECRL),
     "A bad signature should not verify");

  // Check a good signature from cert with good SAN but a different key than the
  // one used to create the signature
  let badKeyChain = oneCRLBadKeyChain.join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, badKeyChain,
                                      verifier.ONECRL),
     "A signature should not verify if the signing key is wrong");

  // Check a good signature from cert with good SAN but a different key than the
  // one used to create the signature (this time, an RSA key)
  let rsaKeyChain = oneCRLBadKeyChain.join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, rsaKeyChain,
                                      verifier.ONECRL),
     "A signature should not verify if the signing key is wrong (RSA)");

  // Check a good signature from cert with good SAN but with chain missing root
  let missingRoot = [oneCRLChain[0], oneCRLChain[1]].join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, missingRoot,
                                      verifier.ONECRL),
     "A signature should not verify if the chain is incomplete (missing root)");

  // Check a good signature from cert with good SAN but with no path to root
  let missingInt = [oneCRLChain[0], oneCRLChain[2]].join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, missingInt,
                                      verifier.ONECRL),
     "A signature should not verify if the chain is incomplete (missing int)");

  // Check good signatures from good certificates with incorrect SANs
  chain1 = oneCRLChain.join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, chain1,
                                      verifier.ABOUT_NEWTAB),
     "A OneCRL signature should not verify if the signer has the newtab SAN");

  chain2 = remoteNewTabChain.join("\n");
  verifier = getSignatureVerifier();
  ok(!verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, chain2,
                                      verifier.ONECRL),
     "A newtab signature should not verify if the signer has the OneCRL SAN");

  // Check malformed signature data
  chain1 = oneCRLChain.join("\n");
  let bad_signatures = [
    // wrong length
    "p384ecdsa=WqRXFQ7tnlVufpg7A-ZavXvWd2Zln0o4woHBy26C2rUWM4GJke4pE8ecHiXoi-" +
    "7KnZXty6Pe3s4o3yAIyKDP9jUC52Ek1Gq25j_X703nP5rk5gM1qz5Fe-qCWakPPl6L==",
    // incorrectly encoded
    "p384ecdsa='WqRXFQ7tnlVufpg7A-ZavXvWd2Zln0o4woHBy26C2rUWM4GJke4pE8ecHiXoi" +
    "-7KnZXty6Pe3s4o3yAIyKDP9jUC52Ek1Gq25j_X703nP5rk5gM1qz5Fe-qCWakPPl6L=",
    // missing directive
    "other_directive=WqRXFQ7tnlVufpg7A-ZavXvWd2Zln0o4woHBy26C2rUWM4GJke4pE8ec" +
    "HiXoi-7KnZXty6Pe3s4o3yAIyKDP9jUC52Ek1Gq25j_X703nP5rk5gM1qz5Fe-qCWakPPl6L",
    // actually sha256 with RSA
    "p384ecdsa=XS_jiQsS5qlzQyUKaA1nAnQn_OvxhvDfKybflB8Xe5gNH1wNmPGK1qN-jpeTfK" +
    "6ob3l3gCTXrsMnOXMeht0kPP3wLfVgXbuuO135pQnsv0c-ltRMWLe56Cm4S4Z6E7WWKLPWaj" +
    "jhAcG5dZxjffP9g7tuPP4lTUJztyc4d1z_zQZakEG7R0vN7P5_CaX9MiMzP4R7nC3H4Ba6yi" +
    "yjlGvsZwJ_C5zDQzWWs95czUbMzbDScEZ_7AWnidw91jZn-fUK3xLb6m-Zb_b4GAqZ-vnXIf" +
    "LpLB1Nzal42BQZn7i4rhAldYdcVvy7rOMlsTUb5Zz6vpVW9LCT9lMJ7Sq1xbU-0g=="
    ];
  for (let badSig of bad_signatures) {
    throws(() => {
      verifier = getSignatureVerifier();
      verifier.verifyContentSignature(DATA, badSig, chain1,
                                      verifier.ONECRL);
    }, /NS_ERROR/, `Bad or malformed signature "${badSig}" should be rejected`);
  }

  // Check malformed and missing certificate chain data
  let chainSuffix = [oneCRLChain[1], oneCRLChain[2]].join("\n");
  let badChains = [
    // no data
    "",
    // completely wrong data
    "blah blah \n blah",
    ];

  let badSections = [
    // data that looks like PEM but isn't
    "-----BEGIN CERTIFICATE-----\nBSsPRlYp5+gaFMRIczwUzaioRfteCjr94xyz0g==\n",
    "-----BEGIN CERTIFICATE-----\nBSsPRlYp5+gaFMRIczwUzaioRfteCjr94xyz0g==\n-----END CERTIFICATE-----",
    // data that will start to parse but won't base64decode
    "-----BEGIN CERTIFICATE-----\nnon-base64-stuff\n-----END CERTIFICATE-----",
    // data with garbage outside of PEM sections
    "this data is garbage\n-----BEGIN CERTIFICATE-----\nnon-base64-stuff\n" +
    "-----END CERTIFICATE-----",
    ];

  for (let badSection of badSections) {
    // ensure we test each bad section on its own...
    badChains.push(badSection);
    // ... and as part of a chain with good certificates
    badChains.push(badSection + '\n' + chainSuffix);
  }

  for (let badChain of badChains) {
    throws(() => {
      verifier = getSignatureVerifier();
      verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, badChain,
                                      verifier.ONECRL);
    }, /NS_ERROR/, `Bad chain data starting "${badChain.substring(0, 80)}" ` +
                   "should be rejected");
  }

  // Check the streaming interface works OK when a good chain / data
  // combination is provided
  chain1 = oneCRLChain.join("\n");
  verifier = getSignatureVerifier();
  verifier.createContext("", GOOD_SIGNATURE, chain1, verifier.ONECRL);
  verifier.update(DATA);
  ok(verifier.end(),
     "A good signature should verify using the stream interface");

  // Check that the streaming interface works with multiple update calls
  verifier = getSignatureVerifier();
  verifier.createContext("", GOOD_SIGNATURE, chain1, verifier.ONECRL);
  for (let c of DATA) {
    verifier.update(c);
  }
  ok(verifier.end(),
     "A good signature should verify using multiple updates");

  // Check that the streaming interface works with multiple update calls and
  // some data provided in CreateContext
  verifier = getSignatureVerifier();
  let start = DATA.substring(0, 5);
  let rest = DATA.substring(start.length);
  verifier.createContext(start, GOOD_SIGNATURE, chain1, verifier.ONECRL);
  for (let c of rest) {
    verifier.update(c);
  }
  ok(verifier.end(),
     "A good signature should verify using data in CreateContext and updates");

  // Check that a bad chain / data combination fails
  verifier = getSignatureVerifier();
  verifier.createContext("", GOOD_SIGNATURE, chain1, verifier.ONECRL);
  ok(!verifier.end(),
     "A bad signature should fail using the stream interface");

  // Check that re-creating a context throws ...
  verifier = getSignatureVerifier();
  verifier.createContext("", GOOD_SIGNATURE, chain1, verifier.ONECRL);

  // ... firstly, creating a context explicitly
  throws(() => {
    verifier.createContext(DATA, GOOD_SIGNATURE, chain1, verifier.ONECRL);
  }, /NS_ERROR/, "Ensure a verifier cannot be re-used with createContext");

  // ... secondly, by calling verifyContentSignature
  throws(() => {
    verifier.verifyContentSignature(DATA, GOOD_SIGNATURE, chain1,
                                    verifier.ONECRL);
  }, /NS_ERROR/, "Ensure a verifier cannot be re-used with verifyContentSignature");

  run_next_test();
}
