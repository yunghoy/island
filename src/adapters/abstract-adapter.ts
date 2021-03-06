import { FatalError, ISLAND } from '../utils/error';

/**
 * IAbstractAdapter
 * @interface
 */
export interface IAbstractAdapter {
  adaptee: any;
  initialize(): any | Promise<any>;
  destroy(): any | Promise<any>;
}

/**
 * Abstract adapter class for back-end service.
 * @abstract
 * @class
 * @implements IAbstractAdapter
 */
export default class AbstractAdapter<T, U> implements IAbstractAdapter {
  protected _adaptee: T;
  protected _options: U | undefined;

  public get adaptee(): T { return this._adaptee; }
  protected get options(): U | undefined { return this._options; }

  constructor(options?: U) {
    this._options = options;
  }

  public initialize(): any | Promise<any> {
    throw new FatalError(ISLAND.FATAL.F0005_NOT_IMPLEMENTED_ERROR, 'Not implemented error');
  }

  public destroy(): any | Promise<any> {
    throw new FatalError(ISLAND.FATAL.F0006_NOT_IMPLEMENTED_ERROR, 'Not implemented error');
  }
}
