import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '..', 'src', 'screens', 'records', 'RecordsListScreen.tsx'),
  'utf8',
);

describe('RecordsScreen list architecture', () => {
  it('uses a bounded FlatList instead of eagerly mapping rows in a ScrollView', () => {
    expect(source).toMatch(/\bFlatList\b/);
    expect(source).toMatch(/<FlatList<RecordItem>/);
    expect(source).toMatch(/initialNumToRender=\{10\}/);
    expect(source).toMatch(/maxToRenderPerBatch=\{8\}/);
    expect(source).toMatch(/windowSize=\{7\}/);
    expect(source).not.toMatch(/<ScrollView\b/);
    expect(source).not.toMatch(/visibleRecords\.map\(/);
  });

  it('keeps headers, empty state, cursor controls, and pull refresh attached to the list', () => {
    expect(source).toMatch(/ListHeaderComponent=/);
    expect(source).toMatch(/ListEmptyComponent=/);
    expect(source).toMatch(/ListFooterComponent=/);
    expect(source).toMatch(/refreshControl=/);
    expect(source).toMatch(/<NumberedPagination\b/);
  });
});
