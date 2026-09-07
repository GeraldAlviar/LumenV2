"""Compatibility entrypoint for the 2.1 DOM regression harness.
This is not a real-camera or full-navigation integration test.
"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name('dom_smoke.py')), run_name='__main__')
