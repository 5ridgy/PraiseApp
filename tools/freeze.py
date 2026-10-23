"""Fige une table exportée depuis l'appli (Réglage › Exporter la table) dans data/tables.json.

Usage : python3 tools/freeze.py table-hc.json [table-hec.json ...]
"""
import json, sys, pathlib

data_path = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'tables.json'
data = json.loads(data_path.read_text(encoding='utf-8'))
for f in sys.argv[1:]:
    exp = json.loads(pathlib.Path(f).read_text(encoding='utf-8'))
    book = data['books'][exp['book']]
    songs = book.setdefault('songs', {})
    for n, (page, y) in exp['songs'].items():
        s = songs.setdefault(str(int(n)), {})
        s['p'], s['y'] = int(page), float(y)
    book['pages'] = exp['pages']
    missing = [n for n in range(1, book.get('last', 0) + 1) if not songs.get(str(n), {}).get('p')]
    print(f"{exp['book']}: {len(exp['songs'])} chants, {exp['pages']} pages, manquants : {missing or 'aucun'}")
data_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
