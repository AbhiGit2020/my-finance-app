#!/usr/bin/env python3
import csv
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def read_trades(filename):
    trades = []
    header = None
    with open(filename, newline='', encoding='utf-8-sig') as handle:
        for row in csv.reader(handle):
            if row[:2] == ['Transaction History', 'Header']:
                header = row[2:]
            elif row[:2] == ['Transaction History', 'Data'] and header:
                record = dict(zip(header, row[2:]))
                if record.get('Transaction Type') in ('Buy', 'Sell'):
                    trades.append(record)
    return trades


def number(value):
    return float(value) if value not in ('', '-', None) else 0.0


def natural_key(row):
    return '|'.join(str(row.get(field, '')) for field in (
        'profile', 'date', 'action', 'ticker', 'qty', 'price', 'currency'
    ))


def transform(record, profile, imported_at):
    action = record['Transaction Type'].upper()
    quantity = abs(number(record['Quantity']))
    source_key = '|'.join(record.get(field, '') for field in (
        'Date', 'Account', 'Transaction Type', 'Symbol', 'Quantity', 'Price',
        'Price Currency', 'Gross Amount ', 'Commission', 'Net Amount'
    ))
    digest = hashlib.sha256(source_key.encode('utf-8')).hexdigest()[:24]
    return {
        'txn_id': f'ibkr-{digest}',
        'profile': profile,
        'ticker': record['Symbol'].strip(),
        'action': action,
        'qty': quantity,
        'price': number(record['Price']),
        'commission': abs(number(record['Commission'])),
        'currency': 'USD',
        'broker_currency': record['Price Currency'].strip(),
        'date': record['Date'],
        'notes': f"IBKR: {record['Description'].strip()}",
        'broker_account': record['Account'],
        'gross_amount': number(record['Gross Amount ']),
        'net_amount': number(record['Net Amount']),
        'source': 'IBKR Transaction History CSV',
        'created_at': imported_at,
    }


def main():
    if len(sys.argv) < 4:
        raise SystemExit('Usage: import_ibkr_transactions.py DATA_JSON PROFILE CSV [CSV ...]')

    data_file = Path(sys.argv[1]).resolve()
    profile = sys.argv[2]
    source_files = [Path(value).resolve() for value in sys.argv[3:]]
    data = json.loads(data_file.read_text(encoding='utf-8'))

    accounts = data.get('portfolio_accounts', [])
    if not any(account.get('name') == profile and account.get('active', True) for account in accounts):
        raise SystemExit(f'Active portfolio account not found: {profile}')

    imported_at = datetime.now(timezone.utc).isoformat()
    candidates = []
    for source_file in source_files:
        candidates.extend(transform(row, profile, imported_at) for row in read_trades(source_file))

    existing = data.setdefault('stock_transactions', [])
    existing_ids = {row.get('txn_id') for row in existing}
    existing_keys = {natural_key(row) for row in existing}
    added = []
    skipped = 0
    for row in candidates:
        key = natural_key(row)
        if row['txn_id'] in existing_ids or key in existing_keys:
            skipped += 1
            continue
        added.append(row)
        existing_ids.add(row['txn_id'])
        existing_keys.add(key)

    backup_dir = data_file.parent / 'backups'
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y-%m-%dT%H-%M-%S')
    backup_file = backup_dir / f'import_before_ibkr_{stamp}.json'
    shutil.copy2(data_file, backup_file)

    data['portfolio_accounts'] = [
        account for account in accounts
        if not str(account.get('name', '')).startswith('__')
    ]
    existing.extend(added)
    existing.sort(key=lambda row: (str(row.get('date', '')), str(row.get('ticker', '')), str(row.get('txn_id', ''))))
    data['saved_at'] = imported_at

    temp_file = data_file.with_suffix('.json.tmp')
    temp_file.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    os.replace(temp_file, data_file)

    print(json.dumps({
        'profile': profile,
        'source_rows': len(candidates),
        'added': len(added),
        'skipped_as_duplicates': skipped,
        'total_transactions': len(existing),
        'backup': str(backup_file),
    }, indent=2))


if __name__ == '__main__':
    main()
