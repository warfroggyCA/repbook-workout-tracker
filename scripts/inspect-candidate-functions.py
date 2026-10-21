"""Inventory physical output and every filePathMap source, without publishing app files."""
import hashlib,json,os,re,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]).resolve()
out=root/".vercel/output"
report=Path(sys.argv[2])
files={}; bundles=[]; aliases=[]; problems=[]
affected=re.compile(r"(?:^|/)node_modules/(?:braces|micromatch|fast-glob)(?:/|$)")
imports=re.compile(rb"(?:require\s*\(\s*['\"]|from\s*['\"]|import\s*\(\s*['\"])(?:braces|micromatch|fast-glob)(?:/|['\"])")
fingerprints=set()
for name in ["braces","micromatch","fast-glob"]:
 for p in (root/"node_modules"/name).rglob("*.js"):
  fingerprints.add(hashlib.sha256(p.read_bytes()).hexdigest())
def add(path,label):
 path=path.resolve()
 if not path.is_relative_to(root): problems.append("Escaping package source: "+label);return
 if not path.exists(): problems.append("Missing package source: "+label);return
 if path.is_dir():
  for child in sorted(path.iterdir()): add(child,label+"/"+child.name)
  return
 if not path.is_file(): problems.append("Unsupported file: "+label);return
 data=path.read_bytes();sha=hashlib.sha256(data).hexdigest()
 if affected.search(label): problems.append("Affected dependency path: "+label)
 if path.suffix in {".js",".cjs",".mjs"} and (sha in fingerprints or imports.search(data)):
  problems.append("Affected JavaScript reference/fingerprint: "+label)
 files[label]={"sha256":sha,"bytes":len(data)}
 if path.suffix in {".tar",".tgz"}:
  try:
   with tarfile.open(path) as tar:
    for member in tar.getmembers():
     if affected.search(member.name) or member.name.endswith((".js",".cjs",".mjs")):
      problems.append("Archive requires JavaScript review: "+label+":"+member.name)
  except tarfile.ReadError: problems.append("Unreadable archive: "+label)
for path in sorted(out.rglob("*")):
 if path.is_file() and not path.is_symlink(): add(path,"output/"+path.relative_to(out).as_posix())
 elif path.is_symlink():
  target=path.resolve()
  if not target.exists() or not target.is_relative_to(out): problems.append("Invalid output link: "+path.relative_to(out).as_posix())
  if path.name.endswith(".func"): aliases.append({"route":path.relative_to(out).as_posix(),"target":target.relative_to(out).as_posix()})
for conf in sorted((out/"functions").rglob(".vc-config.json")):
 c=json.loads(conf.read_text());name=conf.parent.relative_to(out).as_posix()
 if c.get("runtime")!="nodejs24.x": problems.append("Unexpected runtime: "+name)
 handler=c.get("handler")
 if not isinstance(handler,str) or not (conf.parent/handler).is_file():problems.append("Missing entry point: "+name)
 for destination,source in c.get("filePathMap",{}).items():
  if ".." in Path(destination).parts or Path(destination).is_absolute():problems.append("Invalid map destination: "+destination)
  add(root/source,"mapped/"+source)
 bundles.append({k:c.get(k) for k in ["handler","runtime","architecture","launcherType","framework"]}|{"bundle":name,"mappedReferences":len(c.get("filePathMap",{}))})
if not bundles:problems.append("No function packages produced")
summary={"bundles":bundles,"routeAliases":aliases,"files":files,"problems":problems,
 "scope":"Physical files, internal aliases, every filePathMap reference with directory expansion, JS imports/fingerprints and TAR members. No deployment/runtime execution; opaque binary data not semantically inspected."}
report.mkdir(parents=True,exist_ok=True)
(report/"function-inventory.json").write_text(json.dumps(summary,indent=2)+"\n")
manifest="".join(k+"\0"+v["sha256"]+"\n" for k,v in sorted(files.items())).encode()
(report/"summary.json").write_text(json.dumps({"bundles":len(bundles),"routeAliases":len(aliases),"inventoryFiles":len(files),"manifestSha256":hashlib.sha256(manifest).hexdigest(),"problems":problems},indent=2)+"\n")
print(json.dumps({"bundles":len(bundles),"files":len(files),"problems":problems}))
sys.exit(bool(problems))
