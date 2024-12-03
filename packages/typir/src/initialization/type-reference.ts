/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { TypeInferenceCollectorListener, TypeInferenceRule } from '../services/inference.js';
import { TypeEdge } from '../graph/type-edge.js';
import { TypeGraphListener } from '../graph/type-graph.js';
import { isType, Type } from '../graph/type-node.js';
import { TypirServices } from '../typir.js';
import { TypeInitializer } from './type-initializer.js';
import { TypeSelector } from './type-selector.js';

/**
 * A listener for TypeReferences, who will be informed about the resolved/found type of the current TypeReference.
 */
export interface TypeReferenceListener<T extends Type = Type> {
    /**
     * Informs when the type of the reference is resolved/found.
     * @param reference the currently resolved TypeReference
     * @param resolvedType Usually the resolved type is either 'Identifiable' or 'Completed',
     * in rare cases this type might be 'Invalid', e.g. if there are corresponding inference rules or TypeInitializers.
     */
    onTypeReferenceResolved(reference: TypeReference<T>, resolvedType: T): void;
    /**
     * Informs when the type of the reference is invalidated/removed.
     * @param reference the currently invalidate/unresolved TypeReference
     * @param previousType undefined occurs in the special case, that the TypeReference never resolved a type so far,
     * but new listeners already want to be informed about the (current) type.
     */
    onTypeReferenceInvalidated(reference: TypeReference<T>, previousType: T | undefined): void;
}

/**
 * A TypeReference accepts a specification for a type and searches for the corresponding type in the type system according to this specification.
 * Different TypeReferences might resolve to the same Type.
 * This class is used during the use case, when a Typir type uses other types for its properties,
 * e.g. class types use other types from the type system for describing the types of its fields ("use existing type").
 *
 * The internal logic of a TypeReference is independent from the kind of the type to resolve.
 * A TypeReference takes care of the lifecycle of the types.
 *
 * Once the type is resolved, listeners are notified about this and all following changes of its state.
 */
export class TypeReference<T extends Type = Type> implements TypeGraphListener, TypeInferenceCollectorListener {
    protected readonly selector: TypeSelector;
    protected readonly services: TypirServices;
    protected resolvedType: T | undefined = undefined;

    /** These listeners will be informed, whenever the resolved state of this TypeReference switched from undefined to an actual type or from an actual type to undefined. */
    protected readonly listeners: Array<TypeReferenceListener<T>> = [];

    // TODO introduce TypeReference factory service in order to replace the implementation?
    constructor(selector: TypeSelector, services: TypirServices) {
        this.selector = selector;
        this.services = services;

        this.startResolving();
    }

    deconstruct() {
        this.stopResolving();
        this.listeners.splice(0, this.listeners.length);
    }

    protected startResolving(): void {
        // discard the previously resolved type (if any)
        this.resolvedType = undefined;

        // react on new types
        this.services.graph.addListener(this);
        // react on new inference rules
        this.services.inference.addListener(this);
        // don't react on state changes of already existing types which are not (yet) completed, since TypeSelectors don't care about the initialization state of types

        // try to resolve now
        this.resolve();
    }

    protected stopResolving(): void {
        // it is not required to listen to new types anymore, since the type is already resolved/found
        this.services.graph.removeListener(this);
        this.services.inference.removeListener(this);
    }

    getType(): T | undefined {
        return this.resolvedType;
    }

    /**
     * Resolves the referenced type, if the type is not yet resolved.
     * Note that the resolved type might not be completed yet.
     * @returns the result of the currently executed resolution
     */
    protected resolve(): 'ALREADY_RESOLVED' | 'SUCCESSFULLY_RESOLVED' | 'RESOLVING_FAILED' {
        if (this.resolvedType) {
            // the type is already resolved => nothing to do
            return 'ALREADY_RESOLVED';
        }

        // try to resolve the type
        const resolvedType = this.tryToResolve(this.selector);

        if (resolvedType) {
            // the type is successfully resolved!
            this.resolvedType = resolvedType;
            this.stopResolving();
            // notify observers
            this.listeners.slice().forEach(listener => listener.onTypeReferenceResolved(this, resolvedType));
            return 'SUCCESSFULLY_RESOLVED';
        } else {
            // the type is not resolved (yet)
            return 'RESOLVING_FAILED';
        }
    }

    /**
     * Tries to find the specified type in the type system.
     * This method does not care about the initialization state of the found type,
     * this method is restricted to just search and find any type according to the given TypeSelector.
     * @param selector the specification for the desired type
     * @returns the found type or undefined, it there is no such type in the type system
     */
    protected tryToResolve(selector: TypeSelector): T | undefined {
        if (isType(selector)) {
            // TODO is there a way to explicitly enforce/ensure "as T"?
            return selector as T;
        } else if (typeof selector === 'string') {
            return this.services.graph.getType(selector) as T;
        } else if (selector instanceof TypeInitializer) {
            return selector.getTypeInitial();
        } else if (selector instanceof TypeReference) {
            return selector.getType();
        } else if (typeof selector === 'function') {
            return this.tryToResolve(selector()); // execute the function and try to recursively resolve the returned result again
        } else { // the selector is of type 'known' => do type inference on it
            const result = this.services.inference.inferType(selector);
            // TODO failures must not be cached, otherwise a type will never be found in the future!!
            if (isType(result)) {
                return result as T;
            } else {
                return undefined;
            }
        }
    }

    addListener(listener: TypeReferenceListener<T>, informAboutCurrentState: boolean): void {
        this.listeners.push(listener);
        if (informAboutCurrentState) {
            if (this.resolvedType) {
                listener.onTypeReferenceResolved(this, this.resolvedType);
            } else {
                listener.onTypeReferenceInvalidated(this, undefined);
            }
        }
    }

    removeListener(listener: TypeReferenceListener<T>): void {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
            this.listeners.splice(index, 1);
        }
    }


    addedType(_addedType: Type, _key: string): void {
        // after adding a new type, try to resolve the type
        this.resolve(); // possible performance optimization: is it possible to do this more performant by looking at the "addedType"?
    }

    removedType(removedType: Type, _key: string): void {
        // the resolved type of this TypeReference is removed!
        if (removedType === this.resolvedType) {
            // notify observers, that the type reference is broken
            this.listeners.slice().forEach(listener => listener.onTypeReferenceInvalidated(this, this.resolvedType!));
            // start resolving the type again
            this.startResolving();
        }
    }

    addedEdge(_edge: TypeEdge): void {
        // only types are relevant
    }
    removedEdge(_edge: TypeEdge): void {
        // only types are relevant
    }

    addedInferenceRule(_rule: TypeInferenceRule, _boundToType?: Type): void {
        // after adding a new inference rule, try to resolve the type
        this.resolve(); // possible performance optimization: use only the new inference rule to resolve the type
    }
    removedInferenceRule(_rule: TypeInferenceRule, _boundToType?: Type): void {
        // empty, since removed inference rules don't help to resolve a type
    }
}


export function resolveTypeSelector(services: TypirServices, selector: TypeSelector): Type {
    if (isType(selector)) {
        return selector;
    } else if (typeof selector === 'string') {
        const result = services.graph.getType(selector);
        if (result) {
            return result;
        } else {
            throw new Error(`A type with identifier '${selector}' as TypeSelector does not exist in the type graph.`);
        }
    } else if (selector instanceof TypeInitializer) {
        return selector.getTypeFinal();
    } else if (selector instanceof TypeReference) {
        return selector.getType();
    } else if (typeof selector === 'function') {
        return resolveTypeSelector(services, selector()); // execute the function and try to recursively resolve the returned result again
    } else {
        const result = services.inference.inferType(selector);
        if (isType(result)) {
            return result;
        } else {
            throw new Error(`For '${services.printer.printDomainElement(selector, false)}' as TypeSelector, no type can be inferred.`);
        }
    }
}