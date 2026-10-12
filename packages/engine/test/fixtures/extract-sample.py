"""Extracts the engine's golden fixture from the sample register (docs/requirements/excel-analysis.md).

Usage: python3 -I extract-sample.py <sample-register.xlsx> > sample-fy2022-23.json

Keeps only what the engine needs: compliance ID, timeline type, criticality, due date, workflow state and
completion date. No names, comments or descriptions (root CLAUDE.md non-negotiable 6). Raw values are mapped the
way docs/contracts/fixtures.md says the importer maps them; rows stay in sheet order.
"""
import json
import sys

import openpyxl

TIMELINE = {"Time Based": "TIME_BASED", "On Going": "ONGOING"}
STATE = {"Complied": "APPROVED", "Pending": "OPEN", "Not Applicable": "NOT_APPLICABLE"}

rows = list(openpyxl.load_workbook(sys.argv[1], read_only=True).active.iter_rows(values_only=True))
header = rows[0]
col = {name: header.index(name) for name in header}
out = []
for r in rows[1:]:
    activity = r[col["Activity Date"]]
    out.append(
        {
            "ref": r[col["EY Compliance ID"]].strip(),
            "timelineType": TIMELINE[r[col["Type (TimeLine)"]].strip()],
            "criticality": r[col["Criticality"]].strip().upper().replace(" ", "_"),
            "dueDate": r[col["Due Date"]].date().isoformat(),
            "workflowState": STATE[r[col["Compliance Status"]].strip()],
            "activityDate": activity.date().isoformat() if activity else None,
        }
    )
json.dump({"source": "sample register, FY 2022-23", "rows": out}, sys.stdout, indent=1)
sys.stdout.write("\n")
