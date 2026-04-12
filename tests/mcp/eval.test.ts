import { describe, expect, it } from 'vitest';
import { getEvaluateValue } from '../../src/mcp/eval';

describe('getEvaluateValue', () => {
  it('returns the nested Runtime.evaluate value', () => {
    const response = {
      id: '1',
      result: {
        result: {
          type: 'string',
          value: 'hello',
        },
      },
    };

    expect(getEvaluateValue(response)).toBe('hello');
  });

  it('returns undefined for missing nested fields', () => {
    expect(getEvaluateValue({})).toBeUndefined();
    expect(getEvaluateValue({ result: {} })).toBeUndefined();
  });
});
