"""Optional independent ICC parsing check. Requires Node and Pillow with LittleCMS.
Uses simulated measurements; does not install profiles or exercise a GPU loader.
"""
import subprocess
from pathlib import Path
from PIL import ImageCms
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
subprocess.run(['node', '--input-type=module', '-e', '''
import { writeFile } from 'node:fs/promises';
import { buildIccProfile } from './js/icc.js';
import { syntheticReadings } from './js/demo.js';
import { analyseGreyscale, buildCorrectionLut } from './js/analysis.js';
import { TARGETS } from './js/patches.js';
for (const target of Object.values(TARGETS)) {
  const grey = analyseGreyscale(syntheticReadings(), target);
  const blob = buildIccProfile({ target, lut: buildCorrectionLut(grey, target), description: 'Synthetic parser check ' + target.id });
  await writeFile('test-results/' + target.id + '.icc', Buffer.from(await blob.arrayBuffer()));
}
'''], cwd=ROOT, check=True)
for name in ['srgb', 'gamma22', 'rec709']:
    profile = ImageCms.getOpenProfile(str(OUT / (name + '.icc')))
    description = ImageCms.getProfileDescription(profile).strip()
    assert description == 'Synthetic parser check ' + name
    ImageCms.buildTransformFromOpenProfiles(profile, ImageCms.createProfile('sRGB'), 'RGB', 'RGB')
    print('PASS:', name, 'opened and an RGB-to-sRGB colour transform was constructed')
print('3 ICC parser checks passed. GPU calibration loading and physical accuracy were not tested.')
