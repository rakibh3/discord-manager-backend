import { Response } from 'express';

type TPagination = {
  page: number;
  limit: number;
  total: number;
};

/**
 * Extra descriptive fields a paged endpoint may attach to `meta` — which period
 * a result set covers, for instance.
 *
 * Open rather than enumerating every endpoint's vocabulary in a shared util,
 * but still constrained to values that survive JSON, so nothing that cannot be
 * serialized reaches the envelope.
 */
type TMetaExtras = Record<
  string,
  string | number | boolean | null | number[] | undefined
>;

type TMeta = TPagination & TMetaExtras;

type TResponse<T> = {
  success: boolean;
  statusCode: number;
  message?: string;
  meta?: TMeta;
  data: T;
};

export const sendResponse = <T>(res: Response, data: TResponse<T>) => {
  res.status(data?.statusCode).json({
    success: data.success,
    statusCode: data.statusCode,
    message: data.message,
    meta: data.meta,
    data: data.data,
  });
};
