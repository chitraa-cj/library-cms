import {
  buildGranthaPublishProgressPlan,
  countPublishableTeekaSlots,
  countHierarchyPublishUnits,
} from "../shared/grantha-publish-progress";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}

// Vedanta Paribhasha–style: 1 adhyaya, 1 khanda, 3 mantras, 1 teeka
const vedantaLike = buildGranthaPublishProgressPlan({
  teekaDefinitions: [{ TeekaName: "Author Teeka", TeekaAuthor: "Author" }],
  hierarchy: [
    {
      khandas: [
        {
          title: "Mangalacharanam",
          manthras: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
      ],
    },
  ],
  levelTwoEnabled: true,
  levelThreeEnabled: false,
});

assertEqual(vedantaLike.grantha, 1, "grantha");
assertEqual(vedantaLike.teekas, 1, "teekas");
assertEqual(vedantaLike.adhyayas, 1, "adhyayas");
assertEqual(vedantaLike.khandas, 1, "khandas");
assertEqual(vedantaLike.padas, 0, "padas");
assertEqual(vedantaLike.mantras, 3, "mantras");
assertEqual(vedantaLike.total, 7, "total = 1+1+1+1+3");
assert(
  vedantaLike.summary.includes("Grantha (1)") && vedantaLike.summary.includes("Mantras (3)"),
  "summary mentions grantha and mantras",
);

// Empty teeka slots must not inflate the total
assertEqual(
  countPublishableTeekaSlots([{ TeekaName: "" }, { TeekaAuthor: "" }]),
  0,
  "blank teekas not counted",
);

// L3: pada counts as section + mantras under pada
const l3 = countHierarchyPublishUnits(
  [
    {
      khandas: [
        {
          title: "Khanda A",
          padas: [{ manthras: [{ id: "a" }, { id: "b" }] }],
        },
      ],
    },
  ],
  { levelThreeEnabled: true, levelTwoEnabled: true },
);
assertEqual(l3.adhyayas, 1, "l3 adhyayas");
assertEqual(l3.khandas, 1, "l3 khandas");
assertEqual(l3.padas, 1, "l3 padas");
assertEqual(l3.mantras, 2, "l3 mantras");

console.log("grantha-publish-progress: all tests passed");
