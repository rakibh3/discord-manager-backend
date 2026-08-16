export type TErrorMessage = {
  path: string;
  message: string;
}[];

export type TErrorResponse = {
  statusCode: number;
  message?: string;
  errorMessage?: string;
  errorDetails: string | any;
  error?: any;
  stack?: string | any;
};
