**English** · [한국어](로직스튜디오.md)

# Using VEXPLOR AAS Studio with VEXPLOR Logic Studio

VEXPLOR AAS Studio makes and checks the AASX of a machine. [VEXPLOR Logic Studio](https://wace.me/en-platform-logic-studio)
is WACE's factory platform (MES, PLM, ERP, QMS and more on one set of tables). The two meet at one file: an AASX that
passed the checks here becomes the equipment register there. Nothing to install in the factory, nothing to convert.

This guide covers what AAS Studio hands over and how. Logic Studio's own screens are described in Logic Studio.

## 1. Three steps

| # | Where | What you do | What happens |
|---|---|---|---|
| 1 | AAS Studio | Fix until **0 errors**, then **Download AASX** | A finished AASX in the metamodel version picked in the download window — V3.0, V3.1 or V3.2 (see below) |
| 2 | Logic Studio Cloud | Drop the file on the **equipment screen** | A preview: types, equipment, plant, line, and anything skipped |
| 3 | Logic Studio Cloud | Check the preview and import | Each machine enters the equipment register, linked to its type |

- **Type and Instance** — a Type file (a machine model) becomes a type; an Instance file (one physical machine) becomes
  equipment. Several machines of one type stay linked to that type.
- **Dropping again is safe** — the same file again changes nothing; a changed file shows only what changed, as proposals
  a person applies or rejects. Nothing is deleted or overwritten on its own.
- **Metamodel version** — AAS Studio 2.9.0 writes each file as the version it came in as, and new models as V3.1
  (usage §4-10). Until Logic Studio confirms that it reads V3.1 · V3.2 files, pick **V3.0** in the download window for
  files you hand to Logic Studio.
- **A process file works too** — company → line → process → equipment from a process grouping (usage §7) becomes plant,
  line and equipment.

## 2. What Logic Studio reads from the file

| From the AASX | Becomes |
|---|---|
| DigitalNameplate — manufacturer, product designation and type, serial number | The equipment's maker, model and serial number |
| HierarchicalStructures — company, line, process | Plant and production line |
| globalAssetId | The key that ties the equipment to this file — the same machine stays the same row |
| AID (collection link), when the file has one | Material for the remote collector's draft read list — used once live values open (see 3) |

## 3. Live values — in preparation

The remote collector (`vexplor-edge`, [install](edge-install.md)) reads PLCs in the factory and sends values out only.
Since 2.5.0 each tag of its read list carries hints — the model element's `semanticId`, a suggested role and limits
from the same file ([contract §4.1](edge-contract.md)) — so a receiver can pre-fill roles and SPC limits for a person
to confirm. A lower limit (`lsl`) comes only from a `Range` element with the same semanticId as the value (its `min`);
the paired limit properties give upper limits only ([integration](integration.md)).

Sending those values to Logic Studio Cloud is **in preparation and not offered yet.** Until then values are collected
and kept by AAS Studio itself (usage §8).

## 4. What stays where

- AAS Studio never writes into Logic Studio. Logic Studio reads the file you give it.
- The AASX stays yours. Keep the original reference model unchanged; give Logic Studio the files you want registered.
- Logic Studio is a separate WACE product with its own terms. AAS Studio stays Apache-2.0 and works without it.
