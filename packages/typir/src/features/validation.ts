/******************************************************************************
 * Copyright 2024 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { Type, isType } from '../graph/type-node.js';
import { Typir } from '../typir.js';
import { isConcreteTypirProblem, TypirProblem } from '../utils/utils-definitions.js';
import { TypeCheckStrategy, createTypeCheckStrategy } from '../utils/utils-type-comparison.js';

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface ValidationMessageDetails {
    domainElement: unknown;
    domainProperty?: string; // name of a property of the domain element; TODO make this type-safe!
    domainIndex?: number; // index, if this property is an Array property
    severity: Severity;
    message: string;
}

export interface ValidationProblem extends ValidationMessageDetails, TypirProblem {
    $problem: 'ValidationProblem';
    subProblems?: TypirProblem[];
}
export const ValidationProblem = 'ValidationProblem';
export function isValidationProblem(problem: unknown): problem is ValidationProblem {
    return isConcreteTypirProblem(problem, ValidationProblem);
}

export type ValidationRule = (domainElement: unknown, typir: Typir) => ValidationProblem[];

/** Annotate types after the validation with additional information in order to ease the creation of usefull messages. */
export interface AnnotatedTypeAfterValidation {
    type: Type;
    userRepresentation: string;
    name: string;
}
export type ValidationMessageProvider = (actual: AnnotatedTypeAfterValidation, expected: AnnotatedTypeAfterValidation) => Partial<ValidationMessageDetails>;

export interface ValidationConstraints {
    ensureNodeIsAssignable(sourceNode: unknown | undefined, expected: Type | undefined | unknown,
        message: ValidationMessageProvider): ValidationProblem[];
    ensureNodeIsEquals(sourceNode: unknown | undefined, expected: Type | undefined | unknown,
        message: ValidationMessageProvider): ValidationProblem[];
    ensureNodeHasNotType(sourceNode: unknown | undefined, notExpected: Type | undefined | unknown,
        message: ValidationMessageProvider): ValidationProblem[];

    ensureNodeRelatedWithType(domainNode: unknown | undefined, expected: Type | undefined | unknown, strategy: TypeCheckStrategy, negated: boolean,
        message: ValidationMessageProvider): ValidationProblem[];
}

export class DefaultValidationConstraints implements ValidationConstraints {
    protected readonly typir: Typir;

    constructor(typir: Typir) {
        this.typir = typir;
    }

    ensureNodeIsAssignable(sourceNode: unknown | undefined, expected: Type | undefined | unknown,
        message: ValidationMessageProvider): ValidationProblem[] {
        return this.ensureNodeRelatedWithType(sourceNode, expected, 'ASSIGNABLE_TYPE', false, message);
    }

    ensureNodeIsEquals(sourceNode: unknown | undefined, expected: Type | undefined | unknown,
        message: ValidationMessageProvider): ValidationProblem[] {
        return this.ensureNodeRelatedWithType(sourceNode, expected, 'EQUAL_TYPE', false, message);
    }

    ensureNodeHasNotType(sourceNode: unknown | undefined, notExpected: Type | undefined | unknown,
        message: ValidationMessageProvider): ValidationProblem[] {
        return this.ensureNodeRelatedWithType(sourceNode, notExpected, 'EQUAL_TYPE', true, message);
    }

    ensureNodeRelatedWithType(domainNode: unknown | undefined, expected: Type | undefined | unknown, strategy: TypeCheckStrategy, negated: boolean,
        message: ValidationMessageProvider): ValidationProblem[] {
        if (domainNode !== undefined && expected !== undefined) {
            const actualType = isType(domainNode) ? domainNode : this.typir.inference.inferType(domainNode);
            const expectedType = isType(expected) ? expected : this.typir.inference.inferType(expected);
            if (isType(actualType) && isType(expectedType)) {
                const strategyLogic = createTypeCheckStrategy(strategy, this.typir);
                const comparisonResult = strategyLogic(actualType, expectedType);
                if (comparisonResult !== undefined) {
                    if (negated) {
                        // everything is fine
                    } else {
                        const details = message(this.annotateType(actualType), this.annotateType(expectedType));
                        return [{
                            $problem: ValidationProblem,
                            domainElement: details.domainElement ?? domainNode,
                            domainProperty: details.domainProperty,
                            domainIndex: details.domainIndex,
                            severity: details.severity ?? 'error',
                            message: details.message ?? `'${actualType.identifier}' is ${negated ? '' : 'not '}related to '${expectedType.identifier}' regarding ${strategy}.`,
                            subProblems: [comparisonResult]
                        }];
                    }
                } else {
                    if (negated) {
                        const details = message(this.annotateType(actualType), this.annotateType(expectedType));
                        return [{
                            $problem: ValidationProblem,
                            domainElement: details.domainElement ?? domainNode,
                            domainProperty: details.domainProperty,
                            domainIndex: details.domainIndex,
                            severity: details.severity ?? 'error',
                            message: details.message ?? `'${actualType.identifier}' is ${negated ? '' : 'not '}related to '${expectedType.identifier}' regarding ${strategy}.`,
                            subProblems: [] // no sub-problems are available!
                        }];
                    } else {
                        // everything is fine
                    }
                }
            } else {
                // ignore inference problems
            }
        }
        return [];
    }

    protected annotateType(type: Type): AnnotatedTypeAfterValidation {
        return {
            type,
            userRepresentation: this.typir.printer.printType(type),
            name: type.identifier,
        };
    }
}


export interface ValidationCollector {
    validate(domainElement: unknown): ValidationProblem[];
    addValidationRules(...rules: ValidationRule[]): void;
}

export class DefaultValidationCollector implements ValidationCollector {
    protected readonly typir: Typir;
    readonly validationRules: ValidationRule[] = [];

    constructor(typir: Typir) {
        this.typir = typir;
    }

    validate(domainElement: unknown): ValidationProblem[] {
        const problems: ValidationProblem[] = [];
        for (const rule of this.validationRules) {
            problems.push(...rule(domainElement, this.typir));
        }
        return problems;
    }

    addValidationRules(...rules: ValidationRule[]): void {
        this.validationRules.push(...rules);
    }
}
