import importlib.util,json
from pathlib import Path,PureWindowsPath
spec=importlib.util.spec_from_file_location('installer',Path(__file__).resolve().parents[1]/'electron/voice/install_qwen.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for value in ['C:'+'\\Users\\example-user\\AppData\\Roaming\\Daemonlet for Codex\\voice\\qwen-managed\\python\\python.exe',r'H:\tts\test\python.exe']:
 text='home = old\ninclude-system-site-packages = false\nversion = 3.11.15\nexecutable = old\ncommand = old\n'
 got=m.relocate_config(text,PureWindowsPath(value))
 assert 'executable = '+value+'\n' in got
 assert 'home = '+str(PureWindowsPath(value).parent)+'\n' in got
 assert '\t' not in got
print(json.dumps({'passed':True,'checks':['actual-python-windows-backslashes-U-t','spaces','home-executable-relocation']}))
