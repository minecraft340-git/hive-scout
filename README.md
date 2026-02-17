# 🛰️ Hive Scout v0.1 Beta
**The Ultimate High-Speed Hive Blockchain Scanner & Curation Engine.**

Hive Scout (formerly Hive Ultimate Scanner v0.49) is a high-performance Node.js bot designed for precision curation. It uses a dual-logic matrix to distinguish between "Fast Track" trusted authors and "Standard" discovery.

## 🧠 Key Logic Features
- **The Multiplier Effect:** Automatically doubles vote weight for followed authors who pass the Fast Track check.
- **Smart Logic OR-Gate:** Followed authors are never penalized; they receive a vote if they pass EITHER the Fast Track OR Standard rules.
- **Persistent Edit Jail:** Remembers "late-edit" offenders across restarts using local JSON memory.
- **Hourly Analytics:** Generates a performance table every 60 minutes to track efficiency.

## 🛠 Installation
1. `npm install @hiveio/dhive`
2. Rename `settings.ini.example` to `settings.ini` and fill in your details.
3. Rename `posting.txt.example` to `posting.txt` and add your Private Posting Key.
4. Run with: `node hivescoutv0.1.js`
