import React,{useState} from 'react';
import {registerRootComponent} from 'expo';
import {View,Text,Button} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {useFonts} from 'expo-font';
import {IBMPlexSans_400Regular} from '@expo-google-fonts/ibm-plex-sans/400Regular';
import {IBMPlexSans_500Medium} from '@expo-google-fonts/ibm-plex-sans/500Medium';
import {IBMPlexSans_600SemiBold} from '@expo-google-fonts/ibm-plex-sans/600SemiBold';
import {IBMPlexSans_700Bold} from '@expo-google-fonts/ibm-plex-sans/700Bold';
import {IBMPlexMono_400Regular} from '@expo-google-fonts/ibm-plex-mono/400Regular';
import {IBMPlexMono_500Medium} from '@expo-google-fonts/ibm-plex-mono/500Medium';
import {IBMPlexMono_600SemiBold} from '@expo-google-fonts/ibm-plex-mono/600SemiBold';
import {ThemeProvider} from '../../src/context/ThemeContext';
import {ReceiptCamera} from '../../src/components/receipt-camera/ReceiptCamera';
function Preview(){
 const[open,setOpen]=useState(true); const[done,setDone]=useState(0);
 const[ready,fontError]=useFonts({IBMPlexSans_400Regular,IBMPlexSans_500Medium,IBMPlexSans_600SemiBold,IBMPlexSans_700Bold,IBMPlexMono_400Regular,IBMPlexMono_500Medium,IBMPlexMono_600SemiBold});
 if(!ready)return <View style={{flex:1,justifyContent:'center',padding:32,backgroundColor:'#fff'}}><Text>{fontError ? `Preview fonts failed: ${fontError.message}` : 'Loading preview fonts…'}</Text></View>;
 return <SafeAreaProvider><ThemeProvider initialMode="dark">{open?<ReceiptCamera onCancel={()=>setOpen(false)} onDone={sections=>{setDone(sections.length);setOpen(false);}}/>:<View style={{flex:1,justifyContent:'center',padding:32}}><Text>Approved {done} receipt images. Isolated preview: no upload or expense creation.</Text><Button title="Open scanner" onPress={()=>setOpen(true)}/></View>}</ThemeProvider></SafeAreaProvider>;
}
registerRootComponent(Preview);
