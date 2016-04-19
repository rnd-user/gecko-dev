/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_DeepSpeechRecognitionService_h
#define mozilla_dom_DeepSpeechRecognitionService_h

#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsISpeechRecognitionService.h"
#include "nsIDeepSpeechTransport.h"

#define NS_DEEPSPEECH_RECOGNITION_SERVICE_CID                         \
  {                                                                   \
    0x783c327c, 0xc568, 0x11e5, {                                     \
      0xb8, 0x6a, 0x94, 0x51, 0xbb, 0x8e, 0x7f, 0x8b                  \
    }                                                                 \
  };

namespace mozilla {

/**
 * DeepSpeech implementation of the nsISpeechRecognitionService interface
 */

class DeepSpeechRecognitionService : public nsISpeechRecognitionService,
                                            public nsIDeepSpeechTransportListener,
                                            public nsIObserver
{
public:
  // Add XPCOM glue code
  NS_DECL_ISUPPORTS
  NS_DECL_NSISPEECHRECOGNITIONSERVICE
  NS_DECL_NSIDEEPSPEECHTRANSPORTLISTENER

  // Add nsIObserver code
  NS_DECL_NSIOBSERVER

  /**
   * Default constructs a DeepSpeechWSRecognitionService
   */
  DeepSpeechRecognitionService();

private:
  /**
   * Private destructor to prevent bypassing of reference counting
   */
  virtual ~DeepSpeechRecognitionService();

  /** The associated SpeechRecognition */
  WeakPtr<dom::SpeechRecognition> mRecognition;
  nsCOMPtr<nsIDeepSpeechTransport> mTransport;

  /**
   * Builds a mock SpeechRecognitionResultList
   */
  dom::SpeechRecognitionResultList* BuildMockResultList();
};

} // namespace mozilla

#endif
