import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import { assertHumanOnly, httpStatus, warn } from '../kit.js';
import { summarizeGeocheckReport } from './geocheckReport.js';

const GEOCHECK_PATH = '/api/connections/geocheck';
const jobId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const input = z.object({
  action: z.enum(['start', 'result']).describe('Start one diagnostic job or read its result once'),
  node_uuid: z.uuid().optional().describe('Required for start; forbidden for result'),
  job_id: jobId.optional().describe('Required for result; use the ID returned by start'),
  ip: z.union([z.ipv4(), z.ipv6()]).optional().describe('Optional source IP for start; exclusive with interface'),
  interface: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/).optional()
    .describe('Optional source interface for start; exclusive with ip'),
}).strict().superRefine((value, ctx) => {
  const reject = (path: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: [path], message });
  };
  if (value.action === 'start') {
    if (value.node_uuid === undefined) reject('node_uuid', 'start requires node_uuid');
    if (value.job_id !== undefined) reject('job_id', 'job_id is only allowed for result');
    if (value.ip !== undefined && value.interface !== undefined) {
      reject('ip', 'Only one of ip and interface may be specified');
    }
  } else {
    if (value.job_id === undefined) reject('job_id', 'result requires job_id');
    for (const field of ['node_uuid', 'ip', 'interface'] as const) {
      if (value[field] !== undefined) reject(field, `${field} is only allowed for start`);
    }
  }
});

const startResponse = z.object({ jobId });
const resultResponse = z.object({
  isCompleted: z.boolean(),
  isFailed: z.boolean(),
  result: z.object({
    success: z.boolean(),
    nodeUuid: z.uuid(),
    rawReport: z.unknown(),
    message: z.string().nullable(),
  }).nullable(),
}).refine((value) => {
  if (value.isCompleted && value.isFailed) return false;
  return value.isCompleted ? value.result !== null : value.result === null;
});

interface GeocheckAnswer {
  status: 'pending' | 'completed' | 'failed' | 'unavailable';
  job_id: string | null;
  node_uuid: string | null;
  /** Queue flags are unknown after start: no implicit poll has taken place. */
  isCompleted: boolean | null;
  isFailed: boolean | null;
  /** This is result.success, not an alias for the queue's isCompleted. */
  success: boolean | null;
  report: Record<string, unknown> | null;
  next_call: { action: 'result'; job_id: string } | null;
  warnings: ToolWarning[];
  degraded: Degraded[];
}

function unavailable(answer: GeocheckAnswer, warning: ToolWarning): GeocheckAnswer {
  answer.status = 'unavailable';
  answer.warnings.push(warning);
  answer.degraded.push({ system: 'remna', error: warning.message });
  return answer;
}

function resume(answer: GeocheckAnswer, id: string): GeocheckAnswer {
  answer.status = 'pending';
  answer.next_call = { action: 'result', job_id: id };
  answer.warnings.push(warn('geocheck_pending',
    'GeoCheck is pending. Wait a few seconds and call result with this job_id; do not start ' +
    'another job to poll. A node may take up to a minute. Finished jobs expire after about 15 minutes.'));
  return answer;
}

/** Upstream may put an arbitrary exception/body into message; only known prose leaves here. */
function nodeFailureMessage(value: string | null): string {
  if (value === 'Node not found.' || value === 'Node did not return a geocheck.') return value;
  return 'The node did not complete GeoCheck successfully; inspect the panel logs for details.';
}

export const nodeGeocheck = defineTool({
  name: 'node_geocheck',
  description:
    'Run a node GeoCheck diagnostic or resume an existing job. start requires node_uuid and ' +
    'optionally one source ip or interface; it queues a read-scope diagnostic with POST and ' +
    'returns job_id immediately. result requires only job_id and makes one GET; pending means ' +
    'call result again later, never start a second job. Requires Remnawave 3.3 and read scopes ' +
    'geocheck (start) / geocheck-result (result). Queue completion and node success are distinct. ' +
    'Returns a bounded schema-1 report summary; raw reports, SVG, base64 images, HTTP bodies ' +
    'and hop arrays are omitted. Human operators only; no restart, drop or sync actions.',
  input,
  access: 'ro',
  risk: 'none',
  profiles: ['human'],
  backends: ['remna'],
  handler: async (args, ctx): Promise<GeocheckAnswer> => {
    assertHumanOnly(ctx, 'node_geocheck is available to the human profile only: it diagnoses node topology.');
    // Keep validation at this boundary too: a direct handler caller must not bypass path safety.
    const params = input.parse(args);
    const answer: GeocheckAnswer = {
      status: 'unavailable', job_id: params.job_id ?? null, node_uuid: params.node_uuid ?? null,
      isCompleted: null, isFailed: null, success: null, report: null, next_call: null,
      warnings: [], degraded: [],
    };

    let response: unknown;
    try {
      if (params.action === 'start') {
        const body = {
          ...(params.ip === undefined ? {} : { ip: params.ip }),
          ...(params.interface === undefined ? {} : { interface: params.interface }),
        };
        response = await ctx.remna.send<unknown>('POST',
          `${GEOCHECK_PATH}/${encodeURIComponent(params.node_uuid!)}`, body);
      } else {
        response = await ctx.remna.get<unknown>(`${GEOCHECK_PATH}/${encodeURIComponent(params.job_id!)}`);
      }
    } catch (error: unknown) {
      const status = httpStatus(error);
      const scope = params.action === 'start' ? 'geocheck' : 'geocheck-result';
      const detail = status === 401 || status === 403
        ? `Check the panel credentials and the ${scope} read scope.`
        : status === 404
          ? 'The route or requested node/job is unavailable; check the panel version and ID. Jobs can expire.'
          : status === 429
            ? 'The panel rate limit refused the request; no retry was made.'
            : 'The request could not be completed; no job outcome can be inferred.';
      return unavailable(answer, warn('geocheck_unavailable',
        `GeoCheck ${params.action} unavailable${status === null || status === 0 ? '' : ` (HTTP ${status})`}. ${detail}`));
    }

    if (params.action === 'start') {
      const parsed = startResponse.safeParse(response);
      if (!parsed.success) {
        return unavailable(answer, warn('geocheck_invalid_response',
          'The panel accepted the request but returned no usable job ID. Check the panel before starting another job.'));
      }
      answer.job_id = parsed.data.jobId;
      return resume(answer, parsed.data.jobId);
    }

    const parsed = resultResponse.safeParse(response);
    if (!parsed.success) {
      return unavailable(answer, warn('geocheck_invalid_response',
        'The panel returned malformed or inconsistent GeoCheck state. The job outcome is unknown.'));
    }
    const state = parsed.data;
    answer.isCompleted = state.isCompleted;
    answer.isFailed = state.isFailed;
    if (state.isFailed) {
      answer.status = 'failed';
      answer.warnings.push(warn('geocheck_job_failed', 'The GeoCheck queue job failed without a node result.'));
      return answer;
    }
    if (!state.isCompleted) return resume(answer, params.job_id!);

    const result = state.result!;
    answer.node_uuid = result.nodeUuid;
    answer.success = result.success;
    answer.status = result.success ? 'completed' : 'failed';
    if (!result.success) {
      answer.warnings.push(warn('geocheck_node_failed', nodeFailureMessage(result.message)));
      return answer;
    }
    answer.report = summarizeGeocheckReport(result.rawReport, answer.warnings);
    return answer;
  },
});
