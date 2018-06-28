/*!
 * Copyright (c) 2018-present, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 */

const RequestExecutor = require('./request-executor');
const deepCopy = require('deep-copy');
class DefaultOktaRequestExecutor extends RequestExecutor {
  constructor(config = {}) {
    super();
    this.requestTimeout = config.requestTimeout || 0;
    this.maxRetries = config.maxRetries || 2;
    this.retryCountHeader = 'X-Okta-Retry-Count';
    this.retryForHeader = 'X-Okta-Retry-For';
  }

  buildRetryRequest(request, response) {
    const newRequest = deepCopy(request);
    const requestId = this.getOktaRequestId(response);
    if (!request.startTime) {
      newRequest.startTime = new Date();
    }
    if (!newRequest.headers) {
      newRequest.headers = {};
    }
    if (!newRequest.headers[this.retryForHeader]) {
      newRequest.headers[this.retryForHeader] = requestId;
    }
    newRequest.headers[this.retryCountHeader] =
      newRequest.headers[this.retryCountHeader] ?
      newRequest.headers[this.retryCountHeader] + 1 : 1;
    return newRequest;
  }

  canRetryRequest(response) {
    // Validate that we don't have duplicate headers, see OKTA-112507
    // Duplicate headers are returned by fetch as a comma separated list.
    const retryHeader = this.getRateLimitReset(response);
    return !!(retryHeader && retryHeader.indexOf(',') === - 1);
  }

  dateToEpochSeconds(date) {
    return Math.floor(date.getTime() / 1000);
  }

  fetch(request) {
    return super.fetch(request).then(this.parseResponse.bind(this, request));
  }

  getOktaRequestId(response) {
    return response.headers.get('x-okta-request-id');
  }

  getRateLimitReset(response) {
    return response.headers.get('x-rate-limit-reset');
  }

  getResponseDate(response) {
    return response.headers.get('date');
  }

  getRetryDelayMs(response) {
    // Determine wait time by getting the delta X-Rate-Limit-Reset and the Date header
    // Add 1 second to account for sub second differences between the clocks that create these headers
    const nowDate = new Date(this.getResponseDate(response));
    const retryDate = new Date(parseInt(this.getRateLimitReset(response), 10) * 1000);
    return retryDate.getTime() - nowDate.getTime() + 1000;
  }

  parseResponse(request, response) {
    if (response.status === 429 && this.canRetryRequest(response) && !this.requestHasTimedOut(request) && !(this.maxRetriesReached(request))) {
      return this.retryRequest(request, response);
    }
    return response;
  }

  maxRetriesReached(request) {
    const retryCount = request.headers && request.headers[this.retryCountHeader];
    return retryCount && parseInt(retryCount, 10) >= this.maxRetries;
  }

  requestHasTimedOut(request) {
    return request.startTime && ((new Date() - request.startTime) > this.requestTimeout);
  }

  retryRequest(request, response) {
    const delayMs = this.getRetryDelayMs(response);
    const newRequest = this.buildRetryRequest(request, response);
    return new Promise(resolve => {
      const requestId = this.getOktaRequestId(response);
      this.emit('backoff', request, response, requestId, delayMs);
      setTimeout(() => {
        this.emit('resume', newRequest, requestId);
        resolve(this.fetch(newRequest));
      }, delayMs);
    });
  }
}

module.exports = DefaultOktaRequestExecutor;
