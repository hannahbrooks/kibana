/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getCustomQueryRuleParams, getEsqlRule } from '../../../../objects/rule';
import { createRule } from '../../../../tasks/api_calls/rules';
import { createAzureConnector } from '../../../../tasks/api_calls/connectors';
import { deleteAlertsAndRules, deleteConnectors } from '../../../../tasks/api_calls/common';
import { login } from '../../../../tasks/login';
import { visit } from '../../../../tasks/navigation';
import { CREATE_RULE_URL } from '../../../../urls/navigation';
import { visitRuleDetailsPage } from '../../../../tasks/rule_details';
import { visitRuleEditPage } from '../../../../tasks/edit_rule';
import { setPreferredChatExperienceToAgent } from '../../../../tasks/api_calls/kibana_advanced_settings';
import {
  clickNewAgentBuilderAttachmentButton,
  assertAgentBuilderConversationInputEditorIsEmpty,
  assertNewAgentBuilderAttachmentButtonIsDisabled,
} from '../../../../tasks/agent_builder';
import { NEW_AGENT_BUILDER_ATTACHMENT_BUTTON } from '../../../../screens/agent_builder';

describe(
  'Add rule attachment to chat button',
  {
    tags: ['@serverless', '@ess'],
  },
  () => {
    beforeEach(() => {
      deleteConnectors();
      deleteAlertsAndRules();
      login();
      createAzureConnector();
      setPreferredChatExperienceToAgent();
    });

    it('disables the button on the rule creation page until an ES|QL rule type is selected', () => {
      visit(CREATE_RULE_URL);

      // The form defaults to a non-ES|QL rule type, so AI rule creation starts disabled.
      assertNewAgentBuilderAttachmentButtonIsDisabled();
    });

    it('shows the button enabled with an empty chat input on the ES|QL rule details page', () => {
      createRule(getEsqlRule({ rule_id: 'test-esql-rule', name: 'Test ES|QL Rule' })).then(
        (response) => {
          visitRuleDetailsPage(response.body.id);
        }
      );

      cy.get(NEW_AGENT_BUILDER_ATTACHMENT_BUTTON).should('be.visible').and('not.be.disabled');
      clickNewAgentBuilderAttachmentButton();
      assertAgentBuilderConversationInputEditorIsEmpty();
    });

    it('shows the button enabled with an empty chat input on the ES|QL rule editing page', () => {
      createRule(getEsqlRule({ rule_id: 'test-esql-rule', name: 'Test ES|QL Rule' })).then(
        (response) => {
          visitRuleEditPage(response.body.id);
        }
      );

      cy.get(NEW_AGENT_BUILDER_ATTACHMENT_BUTTON).should('be.visible').and('not.be.disabled');
      clickNewAgentBuilderAttachmentButton();
      assertAgentBuilderConversationInputEditorIsEmpty();
    });

    it('disables the button on a non-ES|QL rule details page', () => {
      createRule(
        getCustomQueryRuleParams({ rule_id: 'test-rule', name: 'Test Rule', enabled: false })
      ).then((response) => {
        visitRuleDetailsPage(response.body.id);
      });

      assertNewAgentBuilderAttachmentButtonIsDisabled();
    });

    it('disables the button on a non-ES|QL rule editing page', () => {
      createRule(
        getCustomQueryRuleParams({ rule_id: 'test-rule', name: 'Test Rule', enabled: false })
      ).then((response) => {
        visitRuleEditPage(response.body.id);
      });

      assertNewAgentBuilderAttachmentButtonIsDisabled();
    });
  }
);
