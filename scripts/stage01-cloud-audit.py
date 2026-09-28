"""Read-only GCP inventory summary; emits no account IDs or resource names."""

import json
import subprocess


GCLOUD = r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"


def read_json(args):
    result = subprocess.run([GCLOUD, *args], capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f"gcloud {' '.join(args[:2])} read failed with exit {result.returncode}")
    return json.loads(result.stdout)


instances = read_json(["compute", "instances", "list", "--format=json(name,status)"])
buckets = read_json(["storage", "buckets", "list", "--format=json(name)"])
repositories = read_json(["artifacts", "repositories", "list", "--format=json(name)"])
triggers = read_json(["builds", "triggers", "list", "--format=json(id,disabled)"])
project_result = subprocess.run([GCLOUD, "config", "get-value", "project"], capture_output=True, text=True, timeout=15)
if project_result.returncode:
    raise RuntimeError("Could not read the active gcloud project.")
billing = read_json(["billing", "projects", "describe", project_result.stdout.strip(),
                     "--format=json(billingEnabled,billingAccountName)"])
print(json.dumps({
    "version": "stage01-cloud-readonly-audit-1",
    "readOnly": True,
    "vmCount": len(instances),
    "runningVmCount": sum(item.get("status") == "RUNNING" for item in instances),
    "cmsEngineRunning": any(item.get("name") == "solo-to-china-engine"
                            and item.get("status") == "RUNNING" for item in instances),
    "bucketCount": len(buckets),
    "artifactRepositoryCount": len(repositories),
    "cloudBuildTriggerCount": len(triggers),
    "billingEnabled": billing.get("billingEnabled"),
    "billingAccountConfigured": bool(billing.get("billingAccountName")),
    "unverified": ["resource ownership outside named CMS VM", "usage and charges", "safe shutdown candidates"],
}, indent=2))
