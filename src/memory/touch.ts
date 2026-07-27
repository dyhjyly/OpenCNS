import { supabase } from "../db.js";


export async function touchMemory(
  id: string
) {

  const {
    data,
    error
  } = await supabase
    .from("memories")
    .select(
      "id, importance, access_count"
    )
    .eq(
      "id",
      id
    )
    .single();


  if(error || !data){

    return {
      success:false,
      reason:"not-found",
    };

  }



  const currentImportance =
    data.importance ?? 0.5;


  const nextImportance =
    Math.min(
      1,
      currentImportance + 0.02
    );



  const {
    error:updateError
  } =
  await supabase
    .from("memories")
    .update({

      access_count:
        (data.access_count ?? 0) + 1,

      last_accessed:
        new Date().toISOString(),

      importance:
        nextImportance,

    })
    .eq(
      "id",
      id
    );



  if(updateError){

    return {
      success:false,
      reason:updateError.message,
    };

  }



  return {

    success:true,

    access_count:
      (data.access_count ?? 0) + 1,

    importance:
      nextImportance,

  };

}
