"""Build the public-source retrieval corpus from locally archived official records.

Usage: python3 build_corpus.py --source-root /path/to/论文
No network requests, model loads, or private project files are read.
"""
from pathlib import Path
import argparse
import hashlib
import json


def build(root):
    archive = root / '跨文件证据链研究_20260914'
    cn_path = root / '要求对照修订_20260914/数据发现/官方/2023_94_完整76条.json'
    docs, chunks = [], []
    for path in sorted((archive / '官方裁定').glob('*.json')):
        raw = json.loads(path.read_text())
        text = raw['text'].replace('\r', '\n')
        docs.append({
            'id': raw['rulingNumber'], 'title': raw['subject'],
            'date': raw['rulingDate'][:10], 'jurisdiction': 'US',
            'source_url': raw['source_url'], 'text': text,
            'kind': 'official_customs_ruling', 'language': 'en',
            'retrieved_at': raw.get('retrieved_at'),
            'status': {key: raw.get(key) for key in (
                'revokedBy', 'revokes', 'modifiedBy', 'modifies', 'operationallyRevoked')},
            'text_sha256': hashlib.sha256(text.encode()).hexdigest(),
        })
    by_id = {doc['id']: doc for doc in docs}
    raw_chunks = json.loads((archive / '实验/chunks.json').read_text())
    for raw in raw_chunks:
        assert by_id[raw['doc_id']]['text'][raw['start']:raw['end']] == raw['text']
        chunks.append({
            'id': raw['chunk_id'], 'doc_id': raw['doc_id'],
            'start': raw['start'], 'end': raw['end'], 'text': raw['text'],
            'refs': raw['refs'], 'ref_spans': raw['ref_spans'],
        })
    import importlib.util
    spec = importlib.util.spec_from_file_location('ruling_citations', archive / '引用识别.py')
    citations = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(citations)
    for ruling_id in ('966794', '087396', '965440'):
        source = root / '产品官方来源_20260917' / (ruling_id + '.json')
        raw = json.loads(source.read_text())
        text = raw['text'].replace('\r', '\n')
        docs.append({'id': ruling_id, 'title': raw['subject'], 'date': raw['rulingDate'][:10],
                     'jurisdiction': 'US', 'source_url': raw['source_url'], 'text': text,
                     'kind': 'official_customs_ruling', 'language': 'en',
                     'status': {k: raw.get(k) for k in ('revokedBy', 'modifies', 'modifiedBy', 'operationallyRevoked')},
                     'text_sha256': hashlib.sha256(text.encode()).hexdigest()})
        for start in range(0, len(text), 1200):
            end = min(start + 1500, len(text))
            part = text[start:end]
            spans = citations.extract(part, ruling_id)
            chunks.append({'id': ruling_id + ':' + str(start), 'doc_id': ruling_id, 'start': start,
                           'end': end, 'text': part, 'refs': sorted({r['id'] for r in spans}), 'ref_spans': spans})
            if end == len(text): break
    chinese = json.loads(cn_path.read_text())
    for record in chinese:
        doc_id = 'CN-' + record['decision_id']
        text = '\n'.join([
            '商品名称：' + record['name'],
            '规格型号：' + record.get('model', ''),
            '商品描述：' + record['description'],
            '归类理由：' + record['rationale'],
            '公告原税则号列：' + record['official_code'],
        ])
        docs.append({
            'id': doc_id, 'title': record['name'] + ' — ' + record['decision_id'],
            'date': record['publication_date'], 'effective_date': record['effective_date'],
            'jurisdiction': 'CN', 'source_url': record['source_url'], 'text': text,
            'source_location': record['source_location'], 'kind': 'official_classification_decision',
            'language': 'zh', 'official_code': record['official_code'], 'hs6': record['hs6'],
            'status': {'current_validity': 'not_reverified'},
            'text_sha256': hashlib.sha256(text.encode()).hexdigest(),
        })
        chunks.append({'id': doc_id + ':0', 'doc_id': doc_id, 'start': 0,
                       'end': len(text), 'text': text, 'refs': [], 'ref_spans': []})
    tariff_pages = root / '产品官方来源_20260917/税则相关页.json'
    # Optional source refresh: bundled pypdf can reproduce these selected source pages.
    # The 66.7 MB official PDF remains outside the published repository.
    if not tariff_pages.exists() and (root / '产品官方来源_20260917/2026进出口税则.pdf').exists():
        from pypdf import PdfReader
        reader = PdfReader(root / '产品官方来源_20260917/2026进出口税则.pdf')
        page_records = [{'page': n, 'text': reader.pages[n - 1].extract_text()} for n in (1224, 1471, 1472)]
        tariff_pages.write_text(json.dumps(page_records, ensure_ascii=False, indent=2))
    announcement_url = 'https://gss.mof.gov.cn/gzdt/zhengcefabu/202512/t20251231_3981044.htm'
    pdf_url = 'https://gss.mof.gov.cn/gzdt/zhengcefabu/202512/P020251231607833453633.pdf'
    notice_text = '税委会公告2025年第12号。根据《中华人民共和国关税法》相关规定，现公布《中华人民共和国进出口税则（2026）》，自2026年1月1日起实施。'
    additions = [('CN-TARIFF-2026-NOTICE', '2026年进出口税则发布公告', notice_text, announcement_url, None)]
    if tariff_pages.exists():
        for page in json.loads(tariff_pages.read_text()):
            additions.append(('CN-TARIFF-2026-P' + str(page['page']), '2026年进出口税则：相关页 ' + str(page['page']), page['text'], pdf_url + '#page=' + str(page['page']), page['page']))
    for doc_id, title, text, url, page in additions:
        docs.append({'id': doc_id, 'title': title, 'text': text, 'source_url': url,
                     'date': '2025-12-31', 'effective_date': '2026-01-01', 'jurisdiction': 'CN',
                     'kind': 'tariff_source_page' if page else 'official_tariff_notice', 'language': 'zh',
                     'pdf_page': page, 'status': {'subsequent_amendments': 'not_covered', 'numeric_rate_extraction': 'not_validated'},
                     'text_sha256': hashlib.sha256(text.encode()).hexdigest()})
        chunks.append({'id': doc_id + ':0', 'doc_id': doc_id, 'start': 0, 'end': len(text), 'text': text,
                       'refs': [], 'ref_spans': [],
                       'relation_kind': 'published_under_notice' if page else None})
    next(doc for doc in docs if doc['id'] == 'CN-TARIFF-2026-P1224')['verified_rate_row'] = {
        'code': '8509.8030', 'label': '电动牙刷', 'mfn_rate': 8, 'general_rate': 100,
        'scope_note': '仅核验2026基准税则此行，不代表具体进口适用税率；需核对原产地、优惠资格、日期与后续调整。协定税率未结构化。',
        'source_url': pdf_url + '#page=1224', 'verified_by': '主代理原页视觉核对'}
    assert len(by_id) == 255 and len(raw_chunks) == 6284 and len(chinese) == 76
    assert len({doc['id'] for doc in docs}) == len(docs)
    assert len({chunk['id'] for chunk in chunks}) == len(chunks)
    all_ids = {doc['id'] for doc in docs}
    refs = {ref for chunk in chunks for ref in chunk['refs']}
    return {'docs': docs, 'chunks': chunks, 'metadata': {
        'schema_version': 1, 'build_method': 'Deterministic extraction of archived official source text; no generated evidence.',
        'document_count': len(docs), 'chunk_count': len(chunks),
        'collections': [
            {'id': 'CBP-CROSS', 'jurisdiction': 'US', 'document_count': 255, 'chunk_count': 6284,
             'date_min': min(d['date'] for d in docs if d['jurisdiction'] == 'US'),
             'date_max': max(d['date'] for d in docs if d['jurisdiction'] == 'US'),
             'scope': 'Previously collected royalty/customs valuation rulings; not comprehensive CROSS coverage.'},
            {'id': 'CN-2023-94', 'jurisdiction': 'CN', 'document_count': 76, 'chunk_count': 76,
             'publication_date': '2023-07-28', 'effective_date': '2023-08-01',
             'scope': 'Text extracted from two official announcement attachments mirrored by MOFCOM; images excluded.'}],
        'reference_target_count': len(refs), 'indexed_reference_target_count': len(refs & all_ids),
        'not_included': ['HKHS 2026 dictionary', 'Complete structured China tariff-rate tables and subsequent amendments',
                         'National statistics or customs trade microdata', 'Private documents',
                         'Academic papers and textbooks'],
        'tariff_source_pages': len(additions) - 1,
        'additional_toothbrush_rulings': ['966794', '087396', '965440'],
        'limitations': [
            '2026 baseline tariff pages are raw PDF extraction; table column order and numeric rate assignment are not validated. Later adjustments are not covered.',
            'Historical source retrieval is not a current tariff-rate determination.',
            'A reference target not in this corpus must be shown as unavailable, not inferred.',
            'References denote citations, not causal relations or endorsement.',
            'Chinese decision codes reflect the publication date, not verified present validity.',
            'Official source availability is not a claim of CC0 licensing or unlimited third-party rights.'],
    }}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('corpus.json'))
    args = parser.parse_args()
    corpus = build(args.source_root)
    data = json.dumps(corpus, ensure_ascii=False, separators=(',', ':')).encode()
    args.output.write_bytes(data)
    print(json.dumps({'documents': len(corpus['docs']), 'chunks': len(corpus['chunks']),
                      'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))
