/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Container} from './ReactDOMHostConfig';
import type {FiberRoot} from 'react-reconciler/src/ReactInternalTypes';
import type {ReactNodeList} from 'shared/ReactTypes';

import {
  getInstanceFromNode,
  isContainerMarkedAsRoot,
  markContainerAsRoot,
  unmarkContainerAsRoot,
} from './ReactDOMComponentTree';
import {listenToAllSupportedEvents} from '../events/DOMPluginEventSystem';
import {isValidContainerLegacy} from './ReactDOMRoot';
import {
  DOCUMENT_NODE,
  ELEMENT_NODE,
  COMMENT_NODE,
} from '../shared/HTMLNodeType';

import {
  createContainer,
  createHydrationContainer,
  findHostInstanceWithNoPortals,
  updateContainer,
  flushSync,
  getPublicRootInstance,
  findHostInstance,
  findHostInstanceWithWarning,
} from 'react-reconciler/src/ReactFiberReconciler';
import {LegacyRoot} from 'react-reconciler/src/ReactRootTags';
import getComponentNameFromType from 'shared/getComponentNameFromType';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import {has as hasInstance} from 'shared/ReactInstanceMap';

const ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;

let topLevelUpdateWarnings;

if (__DEV__) {
  topLevelUpdateWarnings = (container: Container) => {
    if (container._reactRootContainer && container.nodeType !== COMMENT_NODE) {
      const hostInstance = findHostInstanceWithNoPortals(
        container._reactRootContainer.current,
      );
      if (hostInstance) {
        if (hostInstance.parentNode !== container) {
          console.error(
            'render(...): It looks like the React-rendered content of this ' +
              'container was removed without using React. This is not ' +
              'supported and will cause errors. Instead, call ' +
              'ReactDOM.unmountComponentAtNode to empty a container.',
          );
        }
      }
    }

    const isRootRenderedBySomeReact = !!container._reactRootContainer;
    const rootEl = getReactRootElementInContainer(container);
    const hasNonRootReactChild = !!(rootEl && getInstanceFromNode(rootEl));

    if (hasNonRootReactChild && !isRootRenderedBySomeReact) {
      console.error(
        'render(...): Replacing React-rendered children with a new root ' +
          'component. If you intended to update the children of this node, ' +
          'you should instead have the existing children update their state ' +
          'and render the new components instead of calling ReactDOM.render.',
      );
    }

    if (
      container.nodeType === ELEMENT_NODE &&
      ((container: any): Element).tagName &&
      ((container: any): Element).tagName.toUpperCase() === 'BODY'
    ) {
      console.error(
        'render(): Rendering components directly into document.body is ' +
          'discouraged, since its children are often manipulated by third-party ' +
          'scripts and browser extensions. This may lead to subtle ' +
          'reconciliation issues. Try rendering into a container element created ' +
          'for your app.',
      );
    }
  };
}

function getReactRootElementInContainer(container: any) {
  if (!container) {
    return null;
  }

  if (container.nodeType === DOCUMENT_NODE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

function noopOnRecoverableError() {
  // This isn't reachable because onRecoverableError isn't called in the
  // legacy API.
}

/**
 * 
 * @param {*} container 要挂载的 元素 实例
 * @param {*} initialChildren 要挂载的子组件  ReactElement
 * @param {*} parentComponent 父组件
 * @param {*} callback 
 * @param {*} isHydrationContainer 是否为服务端渲染
 * @returns 
 */
function legacyCreateRootFromDOMContainer(
  container: Container,
  initialChildren: ReactNodeList,
  parentComponent: ?React$Component<any, any>,
  callback: ?Function,
  isHydrationContainer: boolean,
): FiberRoot {
  if (isHydrationContainer) {
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = getPublicRootInstance(root);
        originalCallback.call(instance);
      };
    }

    const root = createHydrationContainer(
      initialChildren,
      callback,
      container,
      LegacyRoot,
      null, // hydrationCallbacks
      false, // isStrictMode
      false, // concurrentUpdatesByDefaultOverride,
      '', // identifierPrefix
      noopOnRecoverableError,
      // TODO(luna) Support hydration later
      null,
    );
    container._reactRootContainer = root;
    markContainerAsRoot(root.current, container);

    const rootContainerElement =
      container.nodeType === COMMENT_NODE ? container.parentNode : container;
    listenToAllSupportedEvents(rootContainerElement);

    // 同步更新
    flushSync();
    return root;
  } else {
    // First clear any existing content.
    let rootSibling;
    // 清空要挂载的 元素实例中的节点
    // 只允许挂载 子组件
    // 说是为了请求占位图或者loading动画
    while ((rootSibling = container.lastChild)) {
      container.removeChild(rootSibling);
    }

    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        // 获取fiberRoot的第一个子元素的（组件、DOM、null）实例
        // fiber.child.stateNode
        // 这里root指的是fiberRoot
        const instance = getPublicRootInstance(root); 
        // 这里instange就是react.render方法中的第一个参数
        originalCallback.call(instance);
      };
    }

    // 这是 fiberRoot
    const root = createContainer(
      container, // 容器节点
      LegacyRoot, // 节点类型 Fiber中 的tag
      null, // hydrationCallbacks
      false, // isStrictMode
      false, // concurrentUpdatesByDefaultOverride,
      '', // identifierPrefix
      noopOnRecoverableError, // onRecoverableError
      null, // transitionCallbacks
    );
    // 给容器的挂载节点加上标记
    container._reactRootContainer = root;
    markContainerAsRoot(root.current, container);

    const rootContainerElement =
      container.nodeType === COMMENT_NODE ? container.parentNode : container;
    listenToAllSupportedEvents(rootContainerElement);

    // Initial mount should not be batched.
    // 初始化渲染要去同步更新
    // 因为批量更新是异步的是可以打断的，但是初始化渲染应该尽快完成不能被打断
    // 所以通过 flushSync 进行同步更新
    flushSync(() => {
      updateContainer(initialChildren, root, parentComponent, callback);
    });

    return root;
  }
}

function warnOnInvalidCallback(callback: mixed, callerName: string): void {
  if (__DEV__) {
    if (callback !== null && typeof callback !== 'function') {
      console.error(
        '%s(...): Expected the last optional `callback` argument to be a ' +
          'function. Instead received: %s.',
        callerName,
        callback,
      );
    }
  }
}

/**
 * 将子树渲染到容器中(初始化 Fiber 数据结构: 创建 fiberRoot 及 rootFiber)
 * @param {*} parentComponent 父组件,初始化渲染传了 null 
 * @param {*} children 要渲染的 ReactElement 元素
 * @param {*} container 渲染挂载的容器
 * @param {*} forceHydrate 是否为服务端渲染
 * @param {*} callback 组件渲染完成后需要执行的回调函数
 * @returns  返回 fiberRoot 的 current.child.stateNode 就是 rootFiber的第一个元素的实例对象 组件实例或者DOM实例或者null（函数式组件没有自己的实例对象）
 */
function legacyRenderSubtreeIntoContainer(
  parentComponent: ?React$Component<any, any>,
  children: ReactNodeList,
  container: Container,
  forceHydrate: boolean,
  callback: ?Function,
) {
  if (__DEV__) {
    topLevelUpdateWarnings(container);
    warnOnInvalidCallback(callback === undefined ? null : callback, 'render');
  }

  /**
   * 检测 container 对象中是否存在 _reactRootContainer 属性
   * 存在表示一个是初始化过的渲染容器
   * maybeRoot 不存在 表示正在进行初始化渲染
   * maybeRoot 存在 表示正在进行更新
   * 
   * react 在初始渲染时会在最外层容器 添加上 _reactRootContainer 属性
   * react 根据此属性进行不同的渲染方式
   */
  const maybeRoot = container._reactRootContainer;
  let root: FiberRoot;
  if (!maybeRoot) {
    // Initial mount 初始化 挂载
    // 创建 fiberRoot 和 rootFiber
    // 返回值是 fiberRoot
    // 还会添加 _reactRootContainer 属性
    root = legacyCreateRootFromDOMContainer(
      // 要挂载的容器
      container,
      // 要挂载的子组件
      children,
      // 父组件
      parentComponent,
      callback,
      forceHydrate,
    );
  } else {
    root = maybeRoot;
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = getPublicRootInstance(root);
        originalCallback.call(instance);
      };
    }
    // Update
    updateContainer(children, root, parentComponent, callback);
  }
  return getPublicRootInstance(root);
}

let didWarnAboutFindDOMNode = false;

export function findDOMNode(
  componentOrElement: Element | ?React$Component<any, any>,
): null | Element | Text {
  if (__DEV__) {
    if (!didWarnAboutFindDOMNode) {
      didWarnAboutFindDOMNode = true;
      console.error(
        'findDOMNode is deprecated and will be removed in the next major ' +
          'release. Instead, add a ref directly to the element you want ' +
          'to reference. Learn more about using refs safely here: ' +
          'https://reactjs.org/link/strict-mode-find-node',
      );
    }

    const owner = (ReactCurrentOwner.current: any);
    if (owner !== null && owner.stateNode !== null) {
      const warnedAboutRefsInRender = owner.stateNode._warnedAboutRefsInRender;
      if (!warnedAboutRefsInRender) {
        console.error(
          '%s is accessing findDOMNode inside its render(). ' +
            'render() should be a pure function of props and state. It should ' +
            'never access something that requires stale data from the previous ' +
            'render, such as refs. Move this logic to componentDidMount and ' +
            'componentDidUpdate instead.',
          getComponentNameFromType(owner.type) || 'A component',
        );
      }
      owner.stateNode._warnedAboutRefsInRender = true;
    }
  }
  if (componentOrElement == null) {
    return null;
  }
  if ((componentOrElement: any).nodeType === ELEMENT_NODE) {
    return (componentOrElement: any);
  }
  if (__DEV__) {
    return findHostInstanceWithWarning(componentOrElement, 'findDOMNode');
  }
  return findHostInstance(componentOrElement);
}

export function hydrate(
  element: React$Node,
  container: Container,
  callback: ?Function,
) {
  if (__DEV__) {
    console.error(
      'ReactDOM.hydrate is no longer supported in React 18. Use hydrateRoot ' +
        'instead. Until you switch to the new API, your app will behave as ' +
        "if it's running React 17. Learn " +
        'more: https://reactjs.org/link/switch-to-createroot',
    );
  }

  if (!isValidContainerLegacy(container)) {
    throw new Error('Target container is not a DOM element.');
  }

  if (__DEV__) {
    const isModernRoot =
      isContainerMarkedAsRoot(container) &&
      container._reactRootContainer === undefined;
    if (isModernRoot) {
      console.error(
        'You are calling ReactDOM.hydrate() on a container that was previously ' +
          'passed to ReactDOMClient.createRoot(). This is not supported. ' +
          'Did you mean to call hydrateRoot(container, element)?',
      );
    }
  }
  // TODO: throw or warn if we couldn't hydrate?
  return legacyRenderSubtreeIntoContainer(
    null,
    element,
    container,
    true,
    callback,
  );
}

/**
 * 
 * @param {*} element 要进行渲染的 ReactElement 就是creatElemment函数的返回值
 * @param {*} container 渲染容器 比如 id=root 的 div 实例
 * @param {*} callback 渲染完成后的回调函数
 * @returns 
 * React.render(<App />, document.getElementById("root"))
 */
export function render(
  element: React$Element<any>,
  container: Container,
  callback: ?Function,
) {
  if (__DEV__) {
    console.error(
      'ReactDOM.render is no longer supported in React 18. Use createRoot ' +
        'instead. Until you switch to the new API, your app will behave as ' +
        "if it's running React 17. Learn " +
        'more: https://reactjs.org/link/switch-to-createroot',
    );
  }
  // DOM 元素检查
  if (!isValidContainerLegacy(container)) {
    throw new Error('Target container is not a DOM element.');
  }

  if (__DEV__) {
    const isModernRoot =
      isContainerMarkedAsRoot(container) &&
      container._reactRootContainer === undefined;
    if (isModernRoot) {
      console.error(
        'You are calling ReactDOM.render() on a container that was previously ' +
          'passed to ReactDOMClient.createRoot(). This is not supported. ' +
          'Did you mean to call root.render(element)?',
      );
    }
  }
  // 渲染子树到container当中
  return legacyRenderSubtreeIntoContainer(
    // 父组件
    null,
    // 要渲染的组件
    element,
    // 要挂载的容器
    container,
    // 是否为服务器端渲染
    false,
    callback,
  );
}

export function unstable_renderSubtreeIntoContainer(
  parentComponent: React$Component<any, any>,
  element: React$Element<any>,
  containerNode: Container,
  callback: ?Function,
) {
  if (__DEV__) {
    console.error(
      'ReactDOM.unstable_renderSubtreeIntoContainer() is no longer supported ' +
        'in React 18. Consider using a portal instead. Until you switch to ' +
        "the createRoot API, your app will behave as if it's running React " +
        '17. Learn more: https://reactjs.org/link/switch-to-createroot',
    );
  }

  if (!isValidContainerLegacy(containerNode)) {
    throw new Error('Target container is not a DOM element.');
  }

  if (parentComponent == null || !hasInstance(parentComponent)) {
    throw new Error('parentComponent must be a valid React Component');
  }

  return legacyRenderSubtreeIntoContainer(
    parentComponent,
    element,
    containerNode,
    false,
    callback,
  );
}

let didWarnAboutUnmountComponentAtNode = false;
export function unmountComponentAtNode(container: Container) {
  if (__DEV__) {
    if (!didWarnAboutUnmountComponentAtNode) {
      didWarnAboutUnmountComponentAtNode = true;
      console.error(
        'unmountComponentAtNode is deprecated and will be removed in the ' +
          'next major release. Switch to the createRoot API. Learn ' +
          'more: https://reactjs.org/link/switch-to-createroot',
      );
    }
  }

  if (!isValidContainerLegacy(container)) {
    throw new Error(
      'unmountComponentAtNode(...): Target container is not a DOM element.',
    );
  }

  if (__DEV__) {
    const isModernRoot =
      isContainerMarkedAsRoot(container) &&
      container._reactRootContainer === undefined;
    if (isModernRoot) {
      console.error(
        'You are calling ReactDOM.unmountComponentAtNode() on a container that was previously ' +
          'passed to ReactDOMClient.createRoot(). This is not supported. Did you mean to call root.unmount()?',
      );
    }
  }

  if (container._reactRootContainer) {
    if (__DEV__) {
      const rootEl = getReactRootElementInContainer(container);
      const renderedByDifferentReact = rootEl && !getInstanceFromNode(rootEl);
      if (renderedByDifferentReact) {
        console.error(
          "unmountComponentAtNode(): The node you're attempting to unmount " +
            'was rendered by another copy of React.',
        );
      }
    }

    // Unmount should not be batched.
    flushSync(() => {
      legacyRenderSubtreeIntoContainer(null, null, container, false, () => {
        // $FlowFixMe This should probably use `delete container._reactRootContainer`
        container._reactRootContainer = null;
        unmarkContainerAsRoot(container);
      });
    });
    // If you call unmountComponentAtNode twice in quick succession, you'll
    // get `true` twice. That's probably fine?
    return true;
  } else {
    if (__DEV__) {
      const rootEl = getReactRootElementInContainer(container);
      const hasNonRootReactChild = !!(rootEl && getInstanceFromNode(rootEl));

      // Check if the container itself is a React root node.
      const isContainerReactRoot =
        container.nodeType === ELEMENT_NODE &&
        isValidContainerLegacy(container.parentNode) &&
        !!container.parentNode._reactRootContainer;

      if (hasNonRootReactChild) {
        console.error(
          "unmountComponentAtNode(): The node you're attempting to unmount " +
            'was rendered by React and is not a top-level container. %s',
          isContainerReactRoot
            ? 'You may have accidentally passed in a React root node instead ' +
                'of its container.'
            : 'Instead, have the parent component update its state and ' +
                'rerender in order to remove this component.',
        );
      }
    }

    return false;
  }
}
