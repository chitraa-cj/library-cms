#!/usr/bin/env node --import tsx
/**
 * Level-name inference for the grantha structure page.
 * =====================================================
 * `structureConfig` lives only in portal drafts, so a grantha whose draft was
 * published opens the wizard on DEFAULT_STRUCTURE and the structure page shows
 * "Adhyaya / Khanda / Mantra" for a book that is really Kanda → Prakarana → …
 * These cover reading the names back out of the CMS sections, and the rule that
 * one heading may name only one level.
 *
 * Run: node --import tsx tests/grantha-structure-level-names.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sectionTypeLabels } from "../shared/schema.ts";
import {
  inferLevelNamesFromStrapiSections,
  applyInferredLevelNames,
  resolveLevelNameCollisions,
  sectionTitleLevelWord,
} from "../client/src/lib/grantha-structure-sync.ts";

const infer = (sections) => inferLevelNamesFromStrapiSections(sections, sectionTypeLabels);

test("section.type drives the level names", () => {
  const sections = [
    { documentId: "a1", title: "First", type: "kanda", parent: null },
    { documentId: "a2", title: "Second", type: "kanda", parent: null },
    { documentId: "k1", title: "One", type: "prakarana", parent: { documentId: "a1" } },
    { documentId: "p1", title: "Inner", type: "anuvaka", parent: { documentId: "k1" } },
  ];
  assert.deepEqual(infer(sections), { one: "Kanda", two: "Prakarana", three: "Anuvaka" });
});

test("numbered titles are the fallback when sections carry no type", () => {
  const sections = [
    { documentId: "a1", title: "Adhyaya 1", type: null, parent: null },
    { documentId: "k1", title: "Pada 1", type: null, parent: { documentId: "a1" } },
    { documentId: "k2", title: "Pada 2", type: null, parent: { documentId: "a1" } },
    { documentId: "p1", title: "Adhikaranam 1", type: null, parent: { documentId: "k1" } },
  ];
  assert.deepEqual(infer(sections), { one: "Adhyaya", two: "Pada", three: "Adhikaranam" });
});

test("an unnumbered title still yields a known section word, nothing else", () => {
  assert.equal(sectionTitleLevelWord("Madhu Kanda"), undefined, "not of the <word> <number> form");
  assert.equal(sectionTitleLevelWord("Pada 2"), "Pada");
  assert.equal(sectionTitleLevelWord("KHANDA - 3"), "Khanda");
  assert.equal(sectionTitleLevelWord("_default"), undefined);
  // "Madhu Brahmana"-style titles name their level with the second word.
  assert.equal(infer([{ documentId: "a1", title: "Madhu Kanda", parent: null }]).one, "Kanda");
  assert.deepEqual(infer([{ documentId: "a1", title: "Invocation", parent: null }]), {
    one: undefined,
    two: undefined,
    three: undefined,
  });
});

test("the majority wins when titles disagree", () => {
  const sections = [
    { documentId: "a1", title: "Kanda 1", parent: null },
    { documentId: "a2", title: "Kanda 2", parent: null },
    { documentId: "a3", title: "Chapter 3", parent: null },
  ];
  assert.equal(infer(sections).one, "Kanda");
});

test("inferred names replace defaults but keep an explicit choice", () => {
  const cfg = {
    levelOneEnabled: true,
    levelOneName: "Adhyaya",
    levelTwoEnabled: true,
    levelTwoName: "Vishaya",
    levelThreeEnabled: false,
    levelThreeName: "Pada",
    leafName: "Mantra",
  };
  const next = applyInferredLevelNames(cfg, { one: "Kanda", two: "Prakarana", three: "Varga" });
  assert.equal(next.levelOneName, "Kanda", "default Adhyaya is replaced");
  assert.equal(next.levelTwoName, "Vishaya", "a hand-picked name is kept");
  assert.equal(next.levelThreeName, "Varga", "default Pada is replaced");
  assert.equal(next.leafName, "Mantra");
});

test("level 3 is pushed off a heading level 2 already uses", () => {
  const cfg = {
    levelOneEnabled: true,
    levelOneName: "Adhyaya",
    levelTwoEnabled: true,
    levelTwoName: "Pada",
    levelThreeEnabled: true,
    levelThreeName: "Pada",
    leafName: "Sutra",
  };
  const fixed = resolveLevelNameCollisions(cfg);
  assert.notEqual(fixed.levelThreeName.toLowerCase(), "pada");
  assert.equal(fixed.levelTwoName, "Pada", "the shallower level keeps the name");

  const inferred = applyInferredLevelNames(cfg, { two: "Pada", three: "Adhikaranam" });
  assert.equal(inferred.levelThreeName, "Adhikaranam", "the inferred name is preferred");
});

test("a disabled level never blocks a name", () => {
  const cfg = {
    levelOneEnabled: false,
    levelOneName: "Pada",
    levelTwoEnabled: true,
    levelTwoName: "Pada",
    levelThreeEnabled: false,
    levelThreeName: "Pada",
    leafName: "Mantra",
  };
  assert.equal(resolveLevelNameCollisions(cfg).levelTwoName, "Pada");
});
