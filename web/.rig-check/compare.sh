#!/bin/bash
# usage: compare.sh "<json opts>" ; runs each model, prints mean energy/bad/collapse over clips (excluding Scale_PopIn)
cd "/Users/duyna/Desktop/Img to 3D/web"
OPTS=${1:-'{}'}
FILTER=${2:-'^(?!Scale|Translate|Rotate|Physics)'}
for id in 588784fe-9799-4d71-b532-b166ab39668f c2d80bd6-7fba-4c1a-8cab-48655cdc8e2f 2d9c0c02-efe3-4b54-a5ec-bb31269a55f4 1b13e386-cdaf-4da9-ad45-02d6e788054d; do
  npx tsx .rig-check/check.ts $id "$OPTS" "$FILTER" >/dev/null 2>&1
  python3 -c "
import json;r=json.load(open('/private/tmp/claude-502/-Users-duyna-Desktop-Img-to-3D/31a54945-396b-4ac6-8c43-1a0c65d69d10/scratchpad/last.json'))
n=len(r);print('${id:0:8}', 'E %.2f bad %.0f col %.1f maxE %.2f (%s)'%(sum(x['energy'] for x in r)/n, sum(x['bad'] for x in r)/n, sum(x['collapse'] for x in r)/n, max(x['energy'] for x in r), max(r,key=lambda x:x['energy'])['clip']))"
done
