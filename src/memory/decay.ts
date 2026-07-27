function daysSince(date: string | Date) {
  const now = Date.now();
  const past = new Date(date).getTime();

  return Math.max(
    0,
    (now - past) / (1000 * 60 * 60 * 24)
  );
}



const PROTECTED_TYPES = [
  "identity",
  "goal",
  "preference",
  "relationship",
];



export function computeDecay(params: {

  importance: number;

  last_accessed: string;

  access_count: number;

  memory_type?: string;

}) {


  /*
   * 长期核心记忆保护
   */

  if(
    params.memory_type &&
    PROTECTED_TYPES.includes(
      params.memory_type
    )
  ){

    return {

      importance:
        Math.max(
          params.importance,
          0.7
        ),

      timeDecay:1,

      usageBonus:
        0,

      daysSinceLastAccess:
        0,

      protected:true,

    };

  }



  const days =
    daysSince(
      params.last_accessed
    );



  // 时间衰减

  const timeDecay =
    Math.exp(
      -days * 0.03
    );



  // 使用奖励

  const usageBonus =
    Math.min(
      params.access_count * 0.02,
      0.3
    );



  let newImportance =
    params.importance *
    timeDecay
    +
    usageBonus;



  newImportance =
    Math.max(
      0,
      Math.min(
        1,
        newImportance
      )
    );



  return {

    importance:
      newImportance,

    timeDecay,

    usageBonus,

    daysSinceLastAccess:
      days,

    protected:false,

  };

}