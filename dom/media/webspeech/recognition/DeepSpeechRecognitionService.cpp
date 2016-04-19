/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsThreadUtils.h"
#include "nsXPCOMCIDInternal.h"
#include "DeepSpeechRecognitionService.h"
#include "SpeechGrammar.h"
#include "SpeechRecognition.h"
#include "SpeechRecognitionAlternative.h"
#include "SpeechRecognitionResult.h"
#include "SpeechRecognitionResultList.h"
#include "nsIObserverService.h"
#include "mozilla/Services.h"
#include "nsMemory.h"

#include "mozilla/dom/ToJSValue.h"

struct JSContext;

namespace mozilla {

using namespace dom;

NS_IMPL_ISUPPORTS(DeepSpeechRecognitionService,
                  nsISpeechRecognitionService,
                  nsIDeepSpeechTransportListener,
                  nsIObserver)

DeepSpeechRecognitionService::DeepSpeechRecognitionService()
{
  mTransport = do_CreateInstance("@mozilla.org/webspeech/deepspeechtransport;1");
}

DeepSpeechRecognitionService::~DeepSpeechRecognitionService()
{
}

// CALL START IN JS FALLS HERE
NS_IMETHODIMP
DeepSpeechRecognitionService::Initialize(
    WeakPtr<SpeechRecognition> aSpeechRecognition)
{
  mRecognition = aSpeechRecognition;

  // prepare stream
  nsCOMPtr<nsPIDOMWindowInner> aWindow = do_QueryInterface(mRecognition->GetParentObject());
  AutoJSAPI api;
  if (NS_WARN_IF(!api.Init(aWindow))) {
    return NS_ERROR_NOT_INITIALIZED;
  }
  JSContext *aCtx = api.cx();
  
  RefPtr<DOMMediaStream> aMediaStream = mRecognition->MediaStream();
  JS::Rooted<JS::Value> aStream(aCtx);
  if (!ToJSValue(aCtx, aMediaStream, &aStream)) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  // get service URI
  ErrorResult aRv;
  nsAutoString aURI;
  mRecognition->GetServiceURI(aURI, aRv); // assume no error for now
  if (aURI.IsEmpty()) {
    aURI.Assign(NS_LITERAL_STRING("ws://localhost:7654")); // TODO: make this a pref?
  }

  // start DS transport
  nsresult rv = mTransport->Start(aWindow, this, aURI, aStream, false);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  // observer
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  obs->AddObserver(this, SPEECH_RECOGNITION_TEST_EVENT_REQUEST_TOPIC, false);
  obs->AddObserver(this, SPEECH_RECOGNITION_TEST_END_TOPIC, false);
  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::ProcessAudioSegment(
  AudioSegment* aAudioSegment, int32_t aSampleRate)
{
  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::SoundEnd()
{
  nsresult rv = mTransport->Stop();
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::ValidateAndSetGrammarList(
  SpeechGrammar* aSpeechGrammar,
  nsISpeechGrammarCompilationCallback* aCallback)
{
  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::Abort()
{
  nsresult rv = mTransport->Abort();
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  return NS_OK;
}

// nsIDeepSpeechTransportListener

NS_IMETHODIMP
DeepSpeechRecognitionService::OnOpen()
{
  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::OnResult(const nsAString& aTranscript, float aConfidence, bool final)
{
  // TODO: support cotinuous results
  // always assume final == true for now

  RefPtr<SpeechEvent> aEvent = new SpeechEvent(
    mRecognition, SpeechRecognition::EVENT_RECOGNITIONSERVICE_FINAL_RESULT);
  SpeechRecognitionResultList* aResultList =
    new SpeechRecognitionResultList(mRecognition);
  SpeechRecognitionResult* aResult = new SpeechRecognitionResult(mRecognition);
  if (mRecognition->MaxAlternatives() > 0) {
    SpeechRecognitionAlternative* aAlternative =
      new SpeechRecognitionAlternative(mRecognition);

    aAlternative->mTranscript = aTranscript;
    aAlternative->mConfidence = aConfidence;

    aResult->mItems.AppendElement(aAlternative);
  }
  aResultList->mItems.AppendElement(aResult);

  aEvent->mRecognitionResultList = aResultList;
  NS_DispatchToMainThread(aEvent);

  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::OnClose()
{
  return NS_OK;
}

NS_IMETHODIMP
DeepSpeechRecognitionService::OnError(nsresult aReason)
{
  mRecognition->DispatchError(
    SpeechRecognition::EVENT_RECOGNITIONSERVICE_ERROR,
    SpeechRecognitionErrorCode::Network,
    NS_LITERAL_STRING("deepspeech transport layer error"));
  return NS_OK;
}

// others

NS_IMETHODIMP
DeepSpeechRecognitionService::Observe(nsISupports* aSubject,
                                              const char* aTopic,
                                              const char16_t* aData)
{
  MOZ_ASSERT(mRecognition->mTestConfig.mFakeRecognitionService,
             "Got request to fake recognition service event, "
             "but " TEST_PREFERENCE_FAKE_RECOGNITION_SERVICE " is not set");

  if (!strcmp(aTopic, SPEECH_RECOGNITION_TEST_END_TOPIC)) {
    nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
    obs->RemoveObserver(this, SPEECH_RECOGNITION_TEST_EVENT_REQUEST_TOPIC);
    obs->RemoveObserver(this, SPEECH_RECOGNITION_TEST_END_TOPIC);

    return NS_OK;
  }

  const nsDependentString eventName = nsDependentString(aData);

  if (eventName.EqualsLiteral("EVENT_RECOGNITIONSERVICE_ERROR")) {
    mRecognition->DispatchError(
      SpeechRecognition::EVENT_RECOGNITIONSERVICE_ERROR,
      SpeechRecognitionErrorCode::Network, // TODO different codes?
      NS_LITERAL_STRING("RECOGNITIONSERVICE_ERROR test event"));

  } else if (eventName.EqualsLiteral("EVENT_RECOGNITIONSERVICE_FINAL_RESULT")) {
    RefPtr<SpeechEvent> event = new SpeechEvent(
      mRecognition, SpeechRecognition::EVENT_RECOGNITIONSERVICE_FINAL_RESULT);

    event->mRecognitionResultList = BuildMockResultList();
    NS_DispatchToMainThread(event);
  }

  return NS_OK;
}

SpeechRecognitionResultList*
DeepSpeechRecognitionService::BuildMockResultList()
{
  SpeechRecognitionResultList* resultList =
    new SpeechRecognitionResultList(mRecognition);
  SpeechRecognitionResult* result = new SpeechRecognitionResult(mRecognition);
  if (0 < mRecognition->MaxAlternatives()) {
    SpeechRecognitionAlternative* alternative =
      new SpeechRecognitionAlternative(mRecognition);

    alternative->mTranscript = NS_LITERAL_STRING("Mock final result");
    alternative->mConfidence = 0.0f;

    result->mItems.AppendElement(alternative);
  }
  resultList->mItems.AppendElement(result);

  return resultList;
}

} // namespace mozilla
