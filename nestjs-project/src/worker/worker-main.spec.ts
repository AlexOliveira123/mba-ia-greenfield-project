/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/unbound-method */
const mockApp = { enableShutdownHooks: jest.fn() };

jest.mock('@nestjs/core', () => ({
  NestFactory: {
    createApplicationContext: jest.fn().mockResolvedValue(mockApp),
  },
}));

jest.mock('./video-worker.module');

const flushPromises = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('worker-main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApp.enableShutdownHooks.mockClear();
    (
      require('@nestjs/core') as typeof import('@nestjs/core')
    ).NestFactory.createApplicationContext = jest
      .fn()
      .mockResolvedValue(mockApp);
  });

  it('calls NestFactory.createApplicationContext with VideoWorkerModule', async () => {
    const { VideoWorkerModule } =
      require('./video-worker.module') as typeof import('./video-worker.module');

    jest.isolateModules(() => {
      require('./worker-main');
    });
    await flushPromises();

    const { NestFactory } =
      require('@nestjs/core') as typeof import('@nestjs/core');
    expect(NestFactory.createApplicationContext).toHaveBeenCalledWith(
      VideoWorkerModule,
    );
  });

  it('calls app.enableShutdownHooks() after bootstrap', async () => {
    jest.isolateModules(() => {
      require('./worker-main');
    });
    await flushPromises();

    expect(mockApp.enableShutdownHooks).toHaveBeenCalledTimes(1);
  });

  it('logs the error and exits with code 1 when bootstrap fails', async () => {
    const mockErr = new Error('bootstrap fail');
    (
      require('@nestjs/core') as typeof import('@nestjs/core')
    ).NestFactory.createApplicationContext = jest
      .fn()
      .mockRejectedValueOnce(mockErr);

    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    jest.isolateModules(() => {
      require('./worker-main');
    });
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith(
      '[worker-main] Bootstrap failed',
      mockErr,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
